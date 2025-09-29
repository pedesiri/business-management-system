import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

// Database configuration for Vercel Postgres
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { init_key } = req.body;
    
    // Simple protection - only allow initialization with correct key
    if (init_key !== process.env.DB_INIT_KEY) {
      return res.status(403).json({ message: 'Invalid initialization key' });
    }

    await initializeDatabase();
    
    res.json({ 
      message: 'Database initialized successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Database initialization error:', error);
    res.status(500).json({ 
      message: 'Database initialization failed',
      error: error.message 
    });
  }
}

// Initialize database (create tables if they don't exist)
async function initializeDatabase() {
  try {
    // Create tables
    await createTables();
    // Seed initial data
    await seedInitialData();
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
    throw error;
  }
}

// Create all required tables
async function createTables() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'sales_rep',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    // Categories table
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Products table
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        category_id INTEGER REFERENCES categories(id),
        sku VARCHAR(100) UNIQUE,
        cost_price DECIMAL(10,2) NOT NULL,
        selling_price DECIMAL(10,2) NOT NULL,
        stock_quantity INTEGER DEFAULT 0,
        min_stock_level INTEGER DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Price history table
    await client.query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        event_type VARCHAR(20) NOT NULL,
        old_price DECIMAL(10,2),
        new_price DECIMAL(10,2) NOT NULL,
        changed_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Customers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(100),
        phone VARCHAR(20),
        address TEXT,
        customer_type VARCHAR(20) DEFAULT 'individual',
        total_purchases DECIMAL(15,2) DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Sales table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        sale_number VARCHAR(50) UNIQUE NOT NULL,
        customer_id INTEGER REFERENCES customers(id),
        sales_rep_id INTEGER REFERENCES users(id),
        subtotal DECIMAL(15,2) NOT NULL,
        discount_amount DECIMAL(10,2) DEFAULT 0,
        tax_amount DECIMAL(10,2) DEFAULT 0,
        total_amount DECIMAL(15,2) NOT NULL,
        commission_amount DECIMAL(10,2) DEFAULT 0,
        commission_rate DECIMAL(5,2) DEFAULT 0,
        payment_method VARCHAR(50),
        payment_status VARCHAR(20) DEFAULT 'completed',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Sale items table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id SERIAL PRIMARY KEY,
        sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        quantity INTEGER NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        total_price DECIMAL(15,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Suppliers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        contact_person VARCHAR(100),
        email VARCHAR(100),
        phone VARCHAR(20),
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Stock movements table
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id),
        movement_type VARCHAR(20) NOT NULL,
        quantity INTEGER NOT NULL,
        reference_type VARCHAR(50),
        reference_id INTEGER,
        notes TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Services table
    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        duration_minutes INTEGER,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await client.query('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sales_rep ON sales(sales_rep_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id)');

    await client.query('COMMIT');
    console.log('✅ All database tables created successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Seed initial data
async function seedInitialData() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Check if admin user exists
    const adminExists = await client.query('SELECT id FROM users WHERE username = $1', ['admin']);
    
    if (adminExists.rows.length === 0) {
      // Create admin user
      const adminPasswordHash = await bcrypt.hash('admin123', 12);
      await client.query(`
        INSERT INTO users (username, email, password_hash, full_name, role, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP)
      `, ['admin', 'admin@nerho.com', adminPasswordHash, 'System Administrator', 'admin']);

      // Create demo sales rep
      const salesPasswordHash = await bcrypt.hash('sales123', 12);
      await client.query(`
        INSERT INTO users (username, email, password_hash, full_name, role, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP)
      `, ['sales_rep', 'sales@nerho.com', salesPasswordHash, 'Demo Sales Representative', 'sales_rep']);

      console.log('✅ Default users created');
    }

    // Check if categories exist
    const categoriesExist = await client.query('SELECT id FROM categories LIMIT 1');
    
    if (categoriesExist.rows.length === 0) {
      // Create sample categories
      await client.query(`
        INSERT INTO categories (name, description, created_at) VALUES
        ('Electronics', 'Electronic devices and accessories', CURRENT_TIMESTAMP),
        ('Clothing', 'Apparel and fashion items', CURRENT_TIMESTAMP),
        ('Books', 'Books and educational materials', CURRENT_TIMESTAMP),
        ('Home & Garden', 'Home improvement and garden supplies', CURRENT_TIMESTAMP),
        ('Sports', 'Sports equipment and accessories', CURRENT_TIMESTAMP)
      `);

      console.log('✅ Sample categories created');
    }

    // Check if products exist
    const productsExist = await client.query('SELECT id FROM products LIMIT 1');
    
    if (productsExist.rows.length === 0) {
      // Get admin user ID for created_by
      const adminUser = await client.query('SELECT id FROM users WHERE username = $1', ['admin']);
      const adminId = adminUser.rows[0].id;

      // Get category IDs
      const electronics = await client.query('SELECT id FROM categories WHERE name = $1', ['Electronics']);
      const clothing = await client.query('SELECT id FROM categories WHERE name = $1', ['Clothing']);
      const books = await client.query('SELECT id FROM categories WHERE name = $1', ['Books']);

      // Create sample products
      await client.query(`
        INSERT INTO products (name, description, category_id, sku, cost_price, selling_price, stock_quantity, min_stock_level, created_by, created_at, updated_at) VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($10, $11, $12, $13, $14, $15, $16, $17, $18, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($19, $20, $21, $22, $23, $24, $25, $26, $27, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($28, $29, $30, $31, $32, $33, $34, $35, $36, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($37, $38, $39, $40, $41, $42, $43, $44, $45, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        'Wireless Bluetooth Headphones', 'High-quality wireless headphones with noise cancellation', electronics.rows[0].id, 'WBH-001', 75.00, 149.99, 50, 10, adminId,
        'Premium Cotton T-Shirt', 'Comfortable 100% cotton t-shirt', clothing.rows[0].id, 'CT-001', 8.00, 24.99, 100, 20, adminId,
        'JavaScript Programming Guide', 'Complete guide to modern JavaScript programming', books.rows[0].id, 'JS-001', 15.00, 39.99, 25, 5, adminId,
        'Smart Home Security Camera', 'WiFi-enabled security camera with mobile app', electronics.rows[0].id, 'SC-001', 45.00, 89.99, 30, 5, adminId,
        'Running Shoes', 'Professional running shoes for athletes', clothing.rows[0].id, 'RS-001', 35.00, 79.99, 75, 15, adminId
      ]);

      console.log('✅ Sample products created');
    }

    // Check if customers exist
    const customersExist = await client.query('SELECT id FROM customers LIMIT 1');
    
    if (customersExist.rows.length === 0) {
      // Get admin user ID for created_by
      const adminUser = await client.query('SELECT id FROM users WHERE username = $1', ['admin']);
      const adminId = adminUser.rows[0].id;

      // Create sample customers
      await client.query(`
        INSERT INTO customers (name, email, phone, address, customer_type, total_purchases, created_by, created_at, updated_at) VALUES
        ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($15, $16, $17, $18, $19, $20, $21, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        'John Smith', 'john.smith@email.com', '+1-555-0101', '123 Main St, City, State 12345', 'individual', 0, adminId,
        'Sarah Johnson', 'sarah.j@email.com', '+1-555-0102', '456 Oak Ave, City, State 12345', 'individual', 0, adminId,
        'ABC Corporation', 'orders@abc-corp.com', '+1-555-0200', '789 Business Blvd, City, State 12345', 'business', 0, adminId
      ]);

      console.log('✅ Sample customers created');
    }

    await client.query('COMMIT');
    console.log('✅ Database seeded with initial data');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
