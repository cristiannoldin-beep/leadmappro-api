const { execSync } = require('child_process')

if (process.env.MIGRATE === 'true') {
  console.log('[entrypoint] Running prisma db push...')
  try {
    execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' })
    console.log('[entrypoint] Schema sync complete.')
  } catch (err) {
    console.error('[entrypoint] Schema sync failed:', err.message)
    process.exit(1)
  }
}

require('./dist/server.js')
