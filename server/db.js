const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "frontier_marketplace",
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: "utf8mb4",
});

// Test the connection
pool
  .getConnection()
  .then((connection) => {
    console.log("MySQL database connected successfully");
    connection.release();
  })
  .catch((err) => {
    console.error("Failed to connect to MySQL database:", err.message);
    console.error("Please ensure:");
    console.error("  1. MySQL is running");
    console.error("  2. Database credentials in .env are correct");
    console.error("  3. The database exists - run: npm run db:setup");
    process.exit(1);
  });

module.exports = pool;
