require('dotenv').config();
const { getMysqlPool, getTablePrefix } = require('../helpers/services/mysqlClient');

async function deleteLoadTestUsers() {
  const pool = getMysqlPool();
  if (!pool) {
    console.error('No MySQL connection — check WP_DB_HOST in .env');
    process.exit(1);
  }

  const pfx = getTablePrefix();

  const [result] = await pool.execute(
    `DELETE p, pm
     FROM \`${pfx}posts\` p
     LEFT JOIN \`${pfx}postmeta\` pm ON pm.post_id = p.ID
     WHERE p.post_type = 'whatsapp_user'
       AND p.post_title = 'Load Test User'`
  );

  console.log(`Deleted ${result.affectedRows} rows`);
  process.exit(0);
}

deleteLoadTestUsers().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});