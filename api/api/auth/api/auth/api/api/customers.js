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
        await handleGetCustomers(req, res, user);
        break;
      
      case 'POST':
        await handleCreateCustomer(req, res, user);
        break;
      
      case 'PUT':
        await handleUpdateCustomer(req, res, user);
        break;
      
      case 'DELETE':
        await handleDeleteCustomer(req, res, user);
        break;
      
      default:
        res.status(405).json({ message: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Customers API error:', error);
    if (error.message.includes('token') || error.message.includes('Invalid') || error.message.includes('inactive')) {
      res.status(401).json({ message: error.message });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
}

// GET /api/customers
async function handleGetCustomers(req, res, user) {
  const result = await pool.query(`
    SELECT 
      c.*,
      u.username as created_by_username,
      COUNT(s.id) as total_sales
    FROM customers c
    LEFT JOIN users u ON c.created_by = u.id
    LEFT JOIN sales s ON c.id = s.customer_id
    GROUP BY c.id, u.username
    ORDER BY c.created_at DESC
  `);

  res.json(result.rows);
}

// POST /api/customers
async function handleCreateCustomer(req, res, user) {
  const {
    name,
    email,
    phone,
    address,
    customer_type = 'individual'
  } = req.body;

  if (!name) {
    return res.status(400).json({ message: 'Customer name is required' });
  }

  // Check if email already exists (if provided)
  if (email) {
    const existingCustomer = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
    if (existingCustomer.rows.length > 0) {
      return res.status(400).json({ message: 'Email already exists' });
    }
  }

  const result = await pool.query(`
    INSERT INTO customers (name, email, phone, address, customer_type, total_purchases, created_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, 0, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING *
  `, [name, email || null, phone || null, address || null, customer_type, user.id]);

  res.status(201).json({
    message: 'Customer created successfully',
    customer: result.rows[0]
  });
}

// PUT /api/customers
async function handleUpdateCustomer(req, res, user) {
  const { id } = req.query;
  const {
    name,
    email,
    phone,
    address,
    customer_type
  } = req.body;

  if (!id) {
    return res.status(400).json({ message: 'Customer ID is required' });
  }

  // Check if customer exists
  const existingCustomer = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  if (existingCustomer.rows.length === 0) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  const current = existingCustomer.rows[0];

  // Check if email already exists (if changing)
  if (email && email !== current.email) {
    const emailExists = await pool.query('SELECT id FROM customers WHERE email = $1 AND id != $2', [email, id]);
    if (emailExists.rows.length > 0) {
      return res.status(400).json({ message: 'Email already exists' });
    }
  }

  const result = await pool.query(`
    UPDATE customers 
    SET name = $1, email = $2, phone = $3, address = $4, customer_type = $5, updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
    RETURNING *
  `, [
    name || current.name,
    email !== undefined ? email : current.email,
    phone !== undefined ? phone : current.phone,
    address !== undefined ? address : current.address,
    customer_type || current.customer_type,
    id
  ]);

  res.json({
    message: 'Customer updated successfully',
    customer: result.rows[0]
  });
}

// DELETE /api/customers
async function handleDeleteCustomer(req, res, user) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ message: 'Customer ID is required' });
  }

  // Check if customer exists
  const customer = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  if (customer.rows.length === 0) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  // Check if customer has any sales
  const salesCheck = await pool.query('SELECT id FROM sales WHERE customer_id = $1 LIMIT 1', [id]);
  if (salesCheck.rows.length > 0) {
    return res.status(400).json({ message: 'Cannot delete customer that has sales history' });
  }

  await pool.query('DELETE FROM customers WHERE id = $1', [id]);

  res.json({ message: 'Customer deleted successfully' });
}
