import { Pool } from 'pg';
import jwt from 'jsonwebtoken';

// Database configuration for Vercel Postgres
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// JWT secret key
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Authenticate token middleware
async function authenticateToken(req) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    throw new Error('Access token required');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Verify user still exists and is active
    const result = await pool.query(
      'SELECT id, username, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      throw new Error('Invalid or inactive user');
    }

    return {
      id: decoded.userId,
      username: decoded.username,
      role: decoded.role
    };
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}

// Generate sale number
function generateSaleNumber() {
  const timestamp = Date.now().toString();
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `SALE-${timestamp.slice(-6)}${random}`;
}

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Authenticate user
    const user = await authenticateToken(req);

    switch (req.method) {
      case 'GET':
        await handleGetSales(req, res, user);
        break;
      
      case 'POST':
        await handleCreateSale(req, res, user);
        break;
      
      case 'PUT':
        await handleUpdateSale(req, res, user);
        break;
      
      case 'DELETE':
        await handleDeleteSale(req, res, user);
        break;
      
      default:
        res.status(405).json({ message: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Sales API error:', error);
    if (error.message.includes('token') || error.message.includes('Invalid') || error.message.includes('inactive')) {
      res.status(401).json({ message: error.message });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
}

// GET /api/sales
async function handleGetSales(req, res, user) {
  const result = await pool.query(`
    SELECT 
      s.*,
      c.name as customer_name,
      u.username as sales_rep_username,
      COUNT(si.id) as item_count
    FROM sales s
    LEFT JOIN customers c ON s.customer_id = c.id
    LEFT JOIN users u ON s.sales_rep_id = u.id
    LEFT JOIN sale_items si ON s.id = si.sale_id
    GROUP BY s.id, c.name, u.username
    ORDER BY s.created_at DESC
  `);

  res.json(result.rows);
}

// POST /api/sales
async function handleCreateSale(req, res, user) {
  const {
    customer_id,
    items, // Array of { product_id, quantity, unit_price }
    discount_amount = 0,
    tax_amount = 0,
    payment_method,
    notes
  } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Sale items are required' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Calculate totals
    let subtotal = 0;
    for (const item of items) {
      if (!item.product_id || !item.quantity || !item.unit_price) {
        throw new Error('Each item must have product_id, quantity, and unit_price');
      }
      subtotal += item.quantity * item.unit_price;
    }

    const total_amount = subtotal - discount_amount + tax_amount;
    const sale_number = generateSaleNumber();

    // Calculate commission (5% for sales reps)
    const commission_rate = user.role === 'sales_rep' ? 5 : 0;
    const commission_amount = (total_amount * commission_rate) / 100;

    // Create sale
    const saleResult = await client.query(`
      INSERT INTO sales (sale_number, customer_id, sales_rep_id, subtotal, discount_amount, 
                        tax_amount, total_amount, commission_amount, commission_rate, 
                        payment_method, payment_status, notes, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'completed', $11, CURRENT_TIMESTAMP)
      RETURNING *
    `, [
      sale_number, customer_id || null, user.id, subtotal, discount_amount,
      tax_amount, total_amount, commission_amount, commission_rate,
      payment_method || null, notes || null
    ]);

    const sale = saleResult.rows[0];

    // Create sale items and update stock
    for (const item of items) {
      // Insert sale item
      await client.query(`
        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total_price, created_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      `, [sale.id, item.product_id, item.quantity, item.unit_price, item.quantity * item.unit_price]);

      // Update product stock
      await client.query(`
        UPDATE products 
        SET stock_quantity = stock_quantity - $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [item.quantity, item.product_id]);

      // Log stock movement
      await client.query(`
        INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, 
                                   reference_id, notes, created_by, created_at)
        VALUES ($1, 'out', $2, 'sale', $3, 'Sale: ${sale_number}', $4, CURRENT_TIMESTAMP)
      `, [item.product_id, item.quantity, sale.id, user.id]);
    }

    // Update customer total purchases if customer exists
    if (customer_id) {
      await client.query(`
        UPDATE customers 
        SET total_purchases = total_purchases + $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [total_amount, customer_id]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Sale created successfully',
      sale
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// PUT /api/sales
async function handleUpdateSale(req, res, user) {
  const { id } = req.query;
  const { payment_method, payment_status, notes } = req.body;

  if (!id) {
    return res.status(400).json({ message: 'Sale ID is required' });
  }

  // Check if sale exists
  const existingSale = await pool.query('SELECT * FROM sales WHERE id = $1', [id]);
  if (existingSale.rows.length === 0) {
    return res.status(404).json({ message: 'Sale not found' });
  }

  const result = await pool.query(`
    UPDATE sales 
    SET payment_method = $1, payment_status = $2, notes = $3
    WHERE id = $4
    RETURNING *
  `, [
    payment_method || existingSale.rows[0].payment_method,
    payment_status || existingSale.rows[0].payment_status,
    notes !== undefined ? notes : existingSale.rows[0].notes,
    id
  ]);

  res.json({
    message: 'Sale updated successfully',
    sale: result.rows[0]
  });
}

// DELETE /api/sales
async function handleDeleteSale(req, res, user) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ message: 'Sale ID is required' });
  }

  // Only allow admin to delete sales
  if (user.role !== 'admin') {
    return res.status(403).json({ message: 'Only admins can delete sales' });
  }

  // Check if sale exists
  const sale = await pool.query('SELECT * FROM sales WHERE id = $1', [id]);
  if (sale.rows.length === 0) {
    return res.status(404).json({ message: 'Sale not found' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get sale items to restore stock
    const items = await client.query('SELECT * FROM sale_items WHERE sale_id = $1', [id]);
    
    // Restore stock for each item
    for (const item of items.rows) {
      await client.query(`
        UPDATE products 
        SET stock_quantity = stock_quantity + $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [item.quantity, item.product_id]);

      // Log stock movement
      await client.query(`
        INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, 
                                   reference_id, notes, created_by, created_at)
        VALUES ($1, 'in', $2, 'sale_delete', $3, 'Sale deletion: ${sale.rows[0].sale_number}', $4, CURRENT_TIMESTAMP)
      `, [item.product_id, item.quantity, sale.id, user.id]);
    }

    // Update customer total purchases if customer exists
    if (sale.rows[0].customer_id) {
      await client.query(`
        UPDATE customers 
        SET total_purchases = total_purchases - $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [sale.rows[0].total_amount, sale.rows[0].customer_id]);
    }

    // Delete sale (cascade will delete sale_items)
    await client.query('DELETE FROM sales WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.json({ message: 'Sale deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
