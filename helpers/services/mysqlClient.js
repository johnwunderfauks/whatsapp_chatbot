const mysql = require("mysql2/promise");

let pool;

/**
 * Returns a shared mysql2 connection pool pointed at the WordPress database,
 * or null if MySQL is not configured (WP_DB_HOST not set).
 *
 * When null is returned, callers should fall back to the WordPress HTTP API.
 *
 * Required env vars (all must be present to enable MySQL mode):
 *   WP_DB_HOST          — MySQL hostname (e.g. mysql.railway.internal)
 *   WP_DB_USER          — MySQL username
 *   WP_DB_PASSWORD      — MySQL password
 *   WP_DB_NAME          — Database name (WordPress database)
 *
 * Optional:
 *   WP_DB_PORT          — MySQL port (default 3306)
 *   WP_DB_POOL_SIZE     — Max simultaneous connections (default 20)
 *   WP_DB_TABLE_PREFIX  — WordPress table prefix (default "wp_")
 */
function getMysqlPool() {
  if (pool) return pool;

  const host     = process.env.WP_DB_HOST;
  const user     = process.env.WP_DB_USER;
  const password = process.env.WP_DB_PASSWORD;
  const database = process.env.WP_DB_NAME;

  // Not configured — caller should use WP HTTP API instead.
  if (!host) return null;

  if (!user || password === undefined || !database) {
    throw new Error(
      "WP_DB_HOST is set but WP_DB_USER, WP_DB_PASSWORD, or WP_DB_NAME is missing."
    );
  }

  pool = mysql.createPool({
    host,
    port:     Number(process.env.WP_DB_PORT || 3306),
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit:    Number(process.env.WP_DB_POOL_SIZE || 100),
    // Cap the wait queue so a sudden burst doesn't accumulate unboundedly in
    // memory.  Requests beyond this limit get an immediate error rather than
    // waiting forever.  2000 gives headroom for a 1000-user burst (each user
    // may fire 1-2 queries) while keeping memory predictable.
    queueLimit:         Number(process.env.WP_DB_QUEUE_LIMIT || 2000),
    connectTimeout:     10_000,
    enableKeepAlive:    true,
    keepAliveInitialDelay: 30_000,
  });

  return pool;
}

/**
 * WordPress table prefix — mirrors $table_prefix in wp-config.php.
 * Override with WP_DB_TABLE_PREFIX if the install uses a non-default prefix.
 */
function getTablePrefix() {
  return process.env.WP_DB_TABLE_PREFIX || "wp_";
}

module.exports = { getMysqlPool, getTablePrefix };
