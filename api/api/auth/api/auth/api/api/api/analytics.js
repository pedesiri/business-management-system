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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Authenticate user
    const user = await authenticateToken(req);

    const analytics = await generateAnalytics(user);
    res.json(analytics);
  } catch (error) {
    console.error('Analytics API error:', error);
    if (error.message.includes('token') || error.message.includes('Invalid') || error.message.includes('inactive')) {
      res.status(401).json({ message: error.message });
    } else {
      res.status(500).json({ message: 'Server error' });
    }
  }
}

async function generateAnalytics(user) {
  const analytics = {};

  // Sales Analytics
  const salesStats = await pool.query(`
    SELECT 
      COUNT(*) as total_sales,
      COALESCE(SUM(total_amount), 0) as total_revenue,
      COALESCE(AVG(total_amount), 0) as avg_sale_amount,
      COALESCE(SUM(commission_amount), 0) as total_commission
    FROM sales
    WHERE created_at >= NOW() - INTERVAL '30 days'
  `);

  analytics.sales = {
    total_sales: parseInt(salesStats.rows[0].total_sales),
    total_revenue: parseFloat(salesStats.rows[0].total_revenue),
    avg_sale_amount: parseFloat(salesStats.rows[0].avg_sale_amount),
    total_commission: parseFloat(salesStats.rows[0].total_commission)
  };

  // Product Analytics
  const productStats = await pool.query(`
    SELECT 
      COUNT(*) as total_products,
      COUNT(*) FILTER (WHERE stock_quantity <= min_stock_level) as low_stock_products,
      COALESCE(SUM(stock_quantity * cost_price), 0) as inventory_value
    FROM products
  `);

  analytics.products = {
    total_products: parseInt(productStats.rows[0].total_products),
    low_stock_products: parseInt(productStats.rows[0].low_stock_products),
    inventory_value: parseFloat(productStats.rows[0].inventory_value)
  };

  // Customer Analytics
  const customerStats = await pool.query(`
    SELECT 
      COUNT(*) as total_customers,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as new_customers_this_month,
      COALESCE(AVG(total_purchases), 0) as avg_customer_value
    FROM customers
  `);

  analytics.customers = {
    total_customers: parseInt(customerStats.rows[0].total_customers),
    new_customers_this_month: parseInt(customerStats.rows[0].new_customers_this_month),
    avg_customer_value: parseFloat(customerStats.rows[0].avg_customer_value)
  };

  // Top Products (by sales volume)
  const topProducts = await pool.query(`
    SELECT 
      p.name,
      p.selling_price,
      SUM(si.quantity) as total_sold,
      SUM(si.total_price) as total_revenue
    FROM products p
    JOIN sale_items si ON p.id = si.product_id
    JOIN sales s ON si.sale_id = s.id
    WHERE s.created_at >= NOW() - INTERVAL '30 days'
    GROUP BY p.id, p.name, p.selling_price
    ORDER BY total_sold DESC
    LIMIT 5
  `);

  analytics.top_products = topProducts.rows.map(row => ({
    name: row.name,
    selling_price: parseFloat(row.selling_price),
    total_sold: parseInt(row.total_sold),
    total_revenue: parseFloat(row.total_revenue)
  }));

  // Sales by Day (last 7 days)
  const dailySales = await pool.query(`
    SELECT 
      DATE(created_at) as sale_date,
      COUNT(*) as sales_count,
      COALESCE(SUM(total_amount), 0) as daily_revenue
    FROM sales
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(created_at)
    ORDER BY sale_date DESC
  `);

  analytics.daily_sales = dailySales.rows.map(row => ({
    date: row.sale_date,
    sales_count: parseInt(row.sales_count),
    revenue: parseFloat(row.daily_revenue)
  }));

  // Sales Rep Performance (if user is admin)
  if (user.role === 'admin') {
    const repPerformance = await pool.query(`
      SELECT 
        u.username,
        u.full_name,
        COUNT(s.id) as total_sales,
        COALESCE(SUM(s.total_amount), 0) as total_revenue,
        COALESCE(SUM(s.commission_amount), 0) as total_commission
      FROM users u
      LEFT JOIN sales s ON u.id = s.sales_rep_id AND s.created_at >= NOW() - INTERVAL '30 days'
      WHERE u.role = 'sales_rep' AND u.is_active = true
      GROUP BY u.id, u.username, u.full_name
      ORDER BY total_revenue DESC
    `);

    analytics.sales_rep_performance = repPerformance.rows.map(row => ({
      username: row.username,
      full_name: row.full_name,
      total_sales: parseInt(row.total_sales),
      total_revenue: parseFloat(row.total_revenue),
      total_commission: parseFloat(row.total_commission)
    }));
  } else {
    // For sales reps, show only their own performance
    const myPerformance = await pool.query(`
      SELECT 
        COUNT(s.id) as total_sales,
        COALESCE(SUM(s.total_amount), 0) as total_revenue,
        COALESCE(SUM(s.commission_amount), 0) as total_commission
      FROM sales s
      WHERE s.sales_rep_id = $1 AND s.created_at >= NOW() - INTERVAL '30 days'
    `, [user.id]);

    analytics.my_performance = {
      total_sales: parseInt(myPerformance.rows[0].total_sales),
      total_revenue: parseFloat(myPerformance.rows[0].total_revenue),
      total_commission: parseFloat(myPerformance.rows[0].total_commission)
    };
  }

  // Recent Sales (last 10)
  const recentSales = await pool.query(`
    SELECT 
      s.sale_number,
      s.total_amount,
      s.created_at,
      c.name as customer_name,
      u.username as sales_rep
    FROM sales s
    LEFT JOIN customers c ON s.customer_id = c.id
    LEFT JOIN users u ON s.sales_rep_id = u.id
    ORDER BY s.created_at DESC
    LIMIT 10
  `);

  analytics.recent_sales = recentSales.rows.map(row => ({
    sale_number: row.sale_number,
    total_amount: parseFloat(row.total_amount),
    created_at: row.created_at,
    customer_name: row.customer_name || 'Walk-in Customer',
    sales_rep: row.sales_rep
  }));

  // Low Stock Alerts
  const lowStockProducts = await pool.query(`
    SELECT 
      name,
      stock_quantity,
      min_stock_level,
      selling_price
    FROM products
    WHERE stock_quantity <= min_stock_level
    ORDER BY (stock_quantity - min_stock_level) ASC
  `);

  analytics.low_stock_alerts = lowStockProducts.rows.map(row => ({
    name: row.name,
    current_stock: parseInt(row.stock_quantity),
    min_level: parseInt(row.min_stock_level),
    selling_price: parseFloat(row.selling_price)
  }));

  return analytics;
}
