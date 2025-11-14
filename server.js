require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

const dbConfig = {
    host: process.env.MYSQLHOST || 'localhost',
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || 'railway',
    port: process.env.MYSQLPORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;

try {
    pool = mysql.createPool(dbConfig);
    console.log('✅ MySQL pool created');
} catch (error) {
    console.error('❌ Pool error:', error);
}

async function initializeDatabase() {
    let connection;
    try {
        connection = await pool.getConnection();
        console.log('✅ MySQL connected');
        
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
        
        console.log('✅ Tables ready');
    } catch (error) {
        console.error('❌ DB error:', error);
    } finally {
        if (connection) connection.release();
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', async (req, res) => {
    try {
        const connection = await pool.getConnection();
        await connection.query('SELECT 1');
        connection.release();
        res.json({ status: 'OK', database: 'connected' });
    } catch (error) {
        res.status(500).json({ status: 'ERROR', error: error.message });
    }
});

app.get('/api/bookings', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        const [rows] = await connection.query(
            'SELECT section_id, slot_number FROM bookings WHERE booking_date = ?',
            [today]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch' });
    } finally {
        if (connection) connection.release();
    }
});

app.post('/api/bookings', async (req, res) => {
    const { section_id, slot_number, full_name, place, mobile } = req.body;
    
    if (!section_id || !slot_number || !full_name || !place || !mobile) {
        return res.status(400).json({ message: 'All fields required' });
    }
    
    if (section_id < 1 || section_id > 5 || slot_number < 1 || slot_number > 5) {
        return res.status(400).json({ message: 'Invalid section/slot' });
    }
    
    if (!/^[0-9]{10}$/.test(mobile)) {
        return res.status(400).json({ message: 'Invalid mobile' });
    }
    
    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        
        const [existing] = await connection.query(
            'SELECT id FROM bookings WHERE section_id = ? AND slot_number = ? AND booking_date = ?',
            [section_id, slot_number, today]
        );
        
        if (existing.length > 0) {
            return res.status(409).json({ message: 'Slot already booked' });
        }
        
        await connection.query(
            'INSERT INTO bookings (section_id, slot_number, full_name, place, mobile, booking_date) VALUES (?, ?, ?, ?, ?, ?)',
            [section_id, slot_number, full_name, place, mobile, today]
        );
        
        console.log(`✅ Booked: S${section_id} Slot${slot_number}`);
        res.status(201).json({ message: 'Success', section_id, slot_number });
    } catch (error) {
        res.status(500).json({ message: 'Booking failed' });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/api/stats', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        
        const [stats] = await connection.query(
            'SELECT section_id, COUNT(*) as booked FROM bookings WHERE booking_date = ? GROUP BY section_id',
            [today]
        );
        
        const [total] = await connection.query(
            'SELECT COUNT(*) as total FROM bookings WHERE booking_date = ?',
            [today]
        );
        
        res.json({ by_section: stats, total: total[0].total, available: 25 - total[0].total });
    } catch (error) {
        res.status(500).json({ message: 'Failed' });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/admin/bookings', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        
        const [rows] = await connection.query(
            'SELECT * FROM bookings WHERE booking_date = ? ORDER BY section_id, slot_number',
            [today]
        );
        
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
                }
                .container {
                    max-width: 1400px;
                    margin: 0 auto;
                    background: white;
                    padding: 30px;
                    border-radius: 15px;
                }
                h1 { color: #764ba2; text-align: center; margin-bottom: 30px; }
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
                    grid-template-columns: repeat(3, 1fr);
                    gap: 20px;
                    margin-bottom: 30px;
                }
                .stat-card {
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    color: white;
                    padding: 20px;
                    border-radius: 10px;
                    text-align: center;
                }
                .stat-number { font-size: 2.5em; font-weight: bold; }
                .stat-label { font-size: 0.9em; margin-top: 5px; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th { background: #764ba2; color: white; padding: 15px; text-align: left; }
                td { padding: 12px 15px; border-bottom: 1px solid #ddd; }
                tr:hover { background: #f5f5f5; }
                .empty { text-align: center; padding: 40px; color: #999; }
            </style>
        </head>
        <body>
            <div class="container">
                <a href="/" class="back-link">← Back</a>
                <h1>🕉️ Admin Panel</h1>
                <div class="stats">
                    <div class="stat-card">
                        <div class="stat-number">${rows.length}</div>
                        <div class="stat-label">Total Bookings</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${25 - rows.length}</div>
                        <div class="stat-label">Available</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${Math.round((rows.length/25)*100)}%</div>
                        <div class="stat-label">Occupancy</div>
                    </div>
                </div>
        `;
        
        if (rows.length === 0) {
            html += '<div class="empty">No bookings today</div>';
        } else {
            html += '<table><tr><th>Section</th><th>Slot</th><th>Name</th><th>Place</th><th>Mobile</th><th>Time</th></tr>';
            rows.forEach(row => {
                html += `<tr>
                    <td>S${row.section_id}</td>
                    <td>Slot ${row.slot_number}</td>
                    <td>${row.full_name}</td>
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
        res.status(500).send('Error');
    } finally {
        if (connection) connection.release();
    }
});

async function resetDailyBookings() {
    let connection;
    try {
        connection = await pool.getConnection();
        const today = new Date().toISOString().split('T')[0];
        
        await connection.query(`
            INSERT INTO archived_bookings (section_id, slot_number, full_name, place, mobile, booking_date)
            SELECT section_id, slot_number, full_name, place, mobile, booking_date
            FROM bookings WHERE booking_date < ?
        `, [today]);
        
        await connection.query('DELETE FROM bookings WHERE booking_date < ?', [today]);
        console.log('✅ Daily reset done');
    } catch (error) {
        console.error('❌ Reset error:', error);
    } finally {
        if (connection) connection.release();
    }
}

cron.schedule('0 0 * * *', () => {
    console.log('🔄 Running reset...');
    resetDailyBookings();
}, { timezone: "Asia/Kolkata" });

async function startServer() {
    try {
        await initializeDatabase();
        app.listen(PORT, '0.0.0.0', () => {
            console.log('\n🚀 ════════════════════════════════');
            console.log('   Temple Booking System Running');
            console.log('   ════════════════════════════════');
            console.log(`   URL: http://localhost:${PORT}`);
            console.log(`   Admin: http://localhost:${PORT}/admin/bookings`);
            console.log('   ════════════════════════════════\n');
        });
    } catch (error) {
        console.error('❌ Start error:', error);
        process.exit(1);
    }
}

startServer();