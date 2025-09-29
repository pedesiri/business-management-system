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
        await handleGetProducts(req, res, user);
        break;
      
      case 'POST':
        await handleCreateProduct(req, res, user);
        break;
      
      case 'PUT':
        await handleUpdateProduct(req, res, user);
        break;
      
      case 'DELETE':
        await handleDeleteProduct(req, res, user);
        break;
      
      default:
        res.status(405).json({ message: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Products API error:', error);
    if (error.message.includes('token') || error.message.includes('Invalid') || error.message.includes('inactive')) {
      res.status(401).json({ message: error.message });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
}

// GET /api/products
async function handleGetProducts(req, res, user) {
  const result = await pool.query(`
    SELECT 
      p.*,
      c.name as category_name,
      u.username as created_by_username
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN users u ON p.created_by = u.id
    ORDER BY p.created_at DESC
  `);

  res.json(result.rows);
}

// POST /api/products
async function handleCreateProduct(req, res, user) {
  const {
    name,
    description,
    category_id,
    sku,
    cost_price,
    selling_price,
    stock_quantity = 0,
    min_stock_level = 0
  } = req.body;

  if (!name || !cost_price || !selling_price) {
    return res.status(400).json({ message: 'Name, cost price, and selling price are required' });
  }

  // Check if SKU already exists (if provided)
  if (sku) {
    const existingSku = await pool.query('SELECT id FROM products WHERE sku = $1', [sku]);
    if (existingSku.rows.length > 0) {
      return res.status(400).json({ message: 'SKU already exists' });
    }
  }

  const result = await pool.query(`
    INSERT INTO products (name, description, category_id, sku, cost_price, selling_price, 
                         stock_quantity, min_stock_level, created_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING *
  `, [name, description, category_id || null, sku || null, cost_price, selling_price, 
      stock_quantity, min_stock_level, user.id]);

  // Log price history
  await pool.query(`
    INSERT INTO price_history (product_id, event_type, new_price, changed_by, created_at)
    VALUES ($1, 'created', $2, $3, CURRENT_TIMESTAMP)
  `, [result.rows[0].id, selling_price, user.id]);

  res.status(201).json({
    message: 'Product created successfully',
    product: result.rows[0]
  });
}

// PUT /api/products
async function handleUpdateProduct(req, res, user) {
  const { id } = req.query;
  const {
    name,
    description,
    category_id,
    sku,
    cost_price,
    selling_price,
    stock_quantity,
    min_stock_level
  } = req.body;

  if (!id) {
    return res.status(400).json({ message: 'Product ID is required' });
  }

  // Get current product data
  const currentProduct = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  if (currentProduct.rows.length === 0) {
    return res.status(404).json({ message: 'Product not found' });
  }

  const current = currentProduct.rows[0];

  // Check if SKU already exists (if changing)
  if (sku && sku !== current.sku) {
    const existingSku = await pool.query('SELECT id FROM products WHERE sku = $1 AND id != $2', [sku, id]);
    if (existingSku.rows.length > 0) {
      return res.status(400).json({ message: 'SKU already exists' });
    }
  }

  const result = await pool.query(`
    UPDATE products 
    SET name = $1, description = $2, category_id = $3, sku = $4, 
        cost_price = $5, selling_price = $6, stock_quantity = $7, 
        min_stock_level = $8, updated_at = CURRENT_TIMESTAMP
    WHERE id = $9
    RETURNING *
  `, [
    name || current.name,
    description !== undefined ? description : current.description,
    category_id !== undefined ? category_id : current.category_id,
    sku !== undefined ? sku : current.sku,
    cost_price || current.cost_price,
    selling_price || current.selling_price,
    stock_quantity !== undefined ? stock_quantity : current.stock_quantity,
    min_stock_level !== undefined ? min_stock_level : current.min_stock_level,
    id
  ]);

  // Log price change if selling price changed
  if (selling_price && selling_price !== current.selling_price) {
    await pool.query(`
      INSERT INTO price_history (product_id, event_type, old_price, new_price, changed_by, created_at)
      VALUES ($1, 'updated', $2, $3, $4, CURRENT_TIMESTAMP)
    `, [id, current.selling_price, selling_price, user.id]);
  }

  res.json({
    message: 'Product updated successfully',
    product: result.rows[0]
  });
}

// DELETE /api/products
async function handleDeleteProduct(req, res, user) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ message: 'Product ID is required' });
  }

  // Check if product exists
  const product = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  if (product.rows.length === 0) {
    return res.status(404).json({ message: 'Product not found' });
  }

  // Check if product is used in any sales
  const salesCheck = await pool.query('SELECT id FROM sale_items WHERE product_id = $1 LIMIT 1', [id]);
  if (salesCheck.rows.length > 0) {
    return res.status(400).json({ message: 'Cannot delete product that has been used in sales' });
  }

  await pool.query('DELETE FROM products WHERE id = $1', [id]);

  res.json({ message: 'Product deleted successfully' });
}
