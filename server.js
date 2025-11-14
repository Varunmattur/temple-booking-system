require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// Database Configuration with Logging
const dbConfig = {
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || 'Varun@12345',
    database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'temple_booking',
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

console.log('🔧 Database Config:', {
    host: dbConfig.host,
    user: dbConfig.user,
    database: dbConfig.database,
    port: dbConfig.port,
    password: dbConfig.password ? '***SET***' : '***NOT SET***'
});

let pool;
let dbConnected = false;

// Create MySQL Pool with Error Handling
async function createPool() {
    try {
        pool = mysql.createPool(dbConfig);
        console.log('✅ MySQL pool created');
        
        // Test connection
        const connection = await pool.getConnection();
        console.log('✅ MySQL connection test successful');
        connection.release();
        dbConnected = true;
        
        return true;
    } catch (error) {
        console.error('❌ MySQL pool creation failed:', error.message);
        console.error('Error details:', error);
        dbConnected = false;
        return false;
    }
}

// Initialize Database Tables
async function initializeDatabase() {
    if (!pool) {
        console.error('❌ Pool not created yet');
        return false;
    }

    let connection;
    try {
        connection = await pool.getConnection();
        console.log('✅ Connected to MySQL database');
        
        // Create bookings table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS bookings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                section_id INT NOT NULL,
                slot_number INT NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                place VARCHAR(255) NOT NULL,
                mobile VARCHAR(15) NOT NULL,
                booking_date DATE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_booking (section_id, slot_number, booking_date),
                INDEX idx_booking_date (booking_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        
        // Create archived bookings table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS archived_bookings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                section_id INT NOT NULL,
                slot_number INT NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                place VARCHAR(255) NOT NULL,
                mobile VARCHAR(15) NOT NULL,
                booking_date DATE NOT NULL,
                archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        
        console.log('✅ Database tables initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        return false;
    } finally {
        if (connection) connection.release();
    }
}

// Serve Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health Check Endpoint
app.get('/api/health', async (req, res) => {
    if (!pool) {
        return res.status(500).json({ 
            status: 'ERROR', 
            database: 'pool not created',
            message: 'Database connection pool not initialized'
        });
    }

    try {
        const connection = await pool.getConnection();
        await connection.query('SELECT 1');
        connection.release();
        res.json({ 
            status: 'OK', 
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Health check failed:', error.message);
        res.status(500).json({ 
            status: 'ERROR', 
            database: 'disconnected',
            error: error.message 
        });
    }
});

// Get All Today's Bookings
app.get('/api/bookings', async (req, res) => {
    if (!pool || !dbConnected) {
        return res.status(500).json({ 
            message: 'Database not connected',
            error: 'Please check Railway MySQL configuration'
        });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        
        const [rows] = await connection.query(
            'SELECT section_id, slot_number FROM bookings WHERE booking_date = ?',
            [today]
        );
        
        console.log(`✅ Fetched ${rows.length} bookings for ${today}`);
        res.json(rows);
    } catch (error) {
        console.error('❌ Error fetching bookings:', error.message);
        res.status(500).json({ 
            message: 'Failed to fetch bookings',
            error: error.message 
        });
    } finally {
        if (connection) connection.release();
    }
});

// Create New Booking
app.post('/api/bookings', async (req, res) => {
    if (!pool || !dbConnected) {
        return res.status(500).json({ 
            message: 'Database not connected' 
        });
    }

    const { section_id, slot_number, full_name, place, mobile } = req.body;
    
    // Validation
    if (!section_id || !slot_number || !full_name || !place || !mobile) {
        return res.status(400).json({ message: 'All fields are required' });
    }
    
    if (section_id < 1 || section_id > 5 || slot_number < 1 || slot_number > 5) {
        return res.status(400).json({ message: 'Invalid section or slot number' });
    }
    
    if (!/^[0-9]{10}$/.test(mobile)) {
        return res.status(400).json({ message: 'Mobile number must be 10 digits' });
    }
    
    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        
        // Check if slot already booked
        const [existing] = await connection.query(
            'SELECT id FROM bookings WHERE section_id = ? AND slot_number = ? AND booking_date = ?',
            [section_id, slot_number, today]
        );
        
        if (existing.length > 0) {
            return res.status(409).json({ message: 'This slot is already booked' });
        }
        
        // Insert booking
        await connection.query(
            'INSERT INTO bookings (section_id, slot_number, full_name, place, mobile, booking_date) VALUES (?, ?, ?, ?, ?, ?)',
            [section_id, slot_number, full_name, place, mobile, today]
        );
        
        console.log(`✅ Booking created: Section ${section_id}, Slot ${slot_number} - ${full_name}`);
        res.status(201).json({ 
            message: 'Booking successful', 
            section_id, 
            slot_number 
        });
    } catch (error) {
        console.error('❌ Booking error:', error.message);
        res.status(500).json({ 
            message: 'Failed to create booking',
            error: error.message 
        });
    } finally {
        if (connection) connection.release();
    }
});

// Get Statistics
app.get('/api/stats', async (req, res) => {
    if (!pool || !dbConnected) {
        return res.status(500).json({ message: 'Database not connected' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        
        const [stats] = await connection.query(
            'SELECT section_id, COUNT(*) as booked_slots FROM bookings WHERE booking_date = ? GROUP BY section_id',
            [today]
        );
        
        const [total] = await connection.query(
            'SELECT COUNT(*) as total FROM bookings WHERE booking_date = ?',
            [today]
        );
        
        res.json({ 
            by_section: stats, 
            total_today: total[0].total,
            available: 25 - total[0].total
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch statistics' });
    } finally {
        if (connection) connection.release();
    }
});

// Admin Panel
app.get('/admin/bookings', async (req, res) => {
    if (!pool || !dbConnected) {
        return res.send(`
            <html>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #dc3545;">❌ Database Not Connected</h1>
                <p>Please check Railway MySQL configuration</p>
                <a href="/">← Back to Home</a>
            </body>
            </html>
        `);
    }

    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        
        const [rows] = await connection.query(
            'SELECT * FROM bookings WHERE booking_date = ? ORDER BY section_id, slot_number',
            [today]
        );
        
        const totalBookings = rows.length;
        const availableSlots = 25 - totalBookings;
        
        let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin Panel</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: Arial, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    padding: 20px;
                    min-height: 100vh;
                }
                .container {
                    max-width: 1400px;
                    margin: 0 auto;
                    background: white;
                    padding: 30px;
                    border-radius: 15px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
                }
                h1 {
                    color: #764ba2;
                    text-align: center;
                    margin-bottom: 30px;
                    font-size: 2.5em;
                }
                .back-link {
                    display: inline-block;
                    margin-bottom: 20px;
                    padding: 10px 20px;
                    background: #764ba2;
                    color: white;
                    text-decoration: none;
                    border-radius: 8px;
                }
                .stats {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }
                .stat-card {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 20px;
                    border-radius: 10px;
                    text-align: center;
                }
                .stat-number { font-size: 2.5em; font-weight: bold; }
                .stat-label { font-size: 0.9em; margin-top: 5px; }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 20px;
                }
                th {
                    background: #764ba2;
                    color: white;
                    padding: 15px;
                    text-align: left;
                }
                td {
                    padding: 12px 15px;
                    border-bottom: 1px solid #ddd;
                }
                tr:hover { background: #f5f5f5; }
                .empty {
                    text-align: center;
                    padding: 40px;
                    color: #999;
                    font-size: 1.2em;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <a href="/" class="back-link">← Back to Booking</a>
                <h1>🕉️ Temple Bookings - Admin Panel</h1>
                
                <div class="stats">
                    <div class="stat-card">
                        <div class="stat-number">${totalBookings}</div>
                        <div class="stat-label">Total Bookings</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${availableSlots}</div>
                        <div class="stat-label">Available Slots</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${Math.round((totalBookings/25)*100)}%</div>
                        <div class="stat-label">Occupancy Rate</div>
                    </div>
                </div>
        `;
        
        if (rows.length === 0) {
            html += '<div class="empty">📭 No bookings found for today</div>';
        } else {
            html += '<table><tr><th>Section</th><th>Slot</th><th>Name</th><th>Place</th><th>Mobile</th><th>Booked At</th></tr>';
            rows.forEach(row => {
                html += `<tr>
                    <td>Section ${row.section_id}</td>
                    <td>Slot ${row.slot_number}</td>
                    <td><strong>${row.full_name}</strong></td>
                    <td>${row.place}</td>
                    <td>${row.mobile}</td>
                    <td>${new Date(row.created_at).toLocaleTimeString()}</td>
                </tr>`;
            });
            html += '</table>';
        }
        
        html += '</div></body></html>';
        res.send(html);
    } catch (error) {
        console.error('❌ Admin panel error:', error);
        res.status(500).send(`
            <html>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1 style="color: #dc3545;">❌ Error</h1>
                <p>${error.message}</p>
                <a href="/">← Back to Home</a>
            </body>
            </html>
        `);
    } finally {
        if (connection) connection.release();
    }
});

// Daily Reset Function
async function resetDailyBookings() {
    if (!pool || !dbConnected) {
        console.log('⚠️ Skipping reset - database not connected');
        return;
    }

    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        
        // Archive old bookings
        await connection.query(`
            INSERT INTO archived_bookings (section_id, slot_number, full_name, place, mobile, booking_date)
            SELECT section_id, slot_number, full_name, place, mobile, booking_date
            FROM bookings WHERE booking_date < ?
        `, [today]);
        
        // Delete old bookings
        await connection.query('DELETE FROM bookings WHERE booking_date < ?', [today]);
        
        console.log('✅ Daily reset completed at', new Date().toISOString());
    } catch (error) {
        console.error('❌ Reset error:', error.message);
    } finally {
        if (connection) connection.release();
    }
}

// Schedule daily reset at midnight IST
cron.schedule('0 0 * * *', () => {
    console.log('🔄 Running daily booking reset...');
    resetDailyBookings();
}, { timezone: "Asia/Kolkata" });

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ message: 'Endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('❌ Global error:', err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
});

// Start Server
async function startServer() {
    try {
        console.log('\n🚀 ════════════════════════════════════════');
        console.log('   Temple Booking System Starting...');
        console.log('   ════════════════════════════════════════');
        
        // Create database pool
        const poolCreated = await createPool();
        if (!poolCreated) {
            console.error('❌ Failed to create database pool');
            console.error('⚠️ Server will start but database features will not work');
            console.error('📋 Please check Railway MySQL configuration');
        }
        
        // Initialize database tables
        if (poolCreated) {
            const dbInitialized = await initializeDatabase();
            if (!dbInitialized) {
                console.error('❌ Failed to initialize database tables');
            }
        }
        
        // Start Express server
        app.listen(PORT, '0.0.0.0', () => {
            console.log('   ════════════════════════════════════════');
            console.log(`   ✅ Server running on port ${PORT}`);
            console.log(`   📍 URL: http://localhost:${PORT}`);
            console.log(`   👤 Admin: http://localhost:${PORT}/admin/bookings`);
            console.log(`   🗄️  Database: ${dbConnected ? '✅ Connected' : '❌ Not Connected'}`);
            console.log('   ════════════════════════════════════════\n');
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful Shutdown
process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM received, shutting down gracefully...');
    if (pool) await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n⚠️ SIGINT received, shutting down gracefully...');
    if (pool) await pool.end();
    process.exit(0);
});

// Start the server
startServer();