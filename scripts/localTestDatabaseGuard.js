export function assertTestApiIdentity(identity, expected) {
  if (identity?.environment !== 'test'
    || identity.database !== expected.database
    || identity.databaseHost !== expected.host
    || String(identity.databasePort) !== expected.port) {
    throw new Error('The API must use the same local test database as this test runner')
  }
}

export function assertLocalTestMongoUri(uri, scriptName, expectedDatabase) {
  let parsed
  try {
    parsed = new URL(uri || '')
  } catch {
    throw new Error(`${scriptName} requires a local test MongoDB URI`)
  }

  const database = parsed.pathname.split('/').filter(Boolean)[0] || ''
  if (parsed.protocol !== 'mongodb:'
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || !/^lexigrow_dev5_test$/i.test(database)
    || parsed.searchParams.has('replicaSet')
    || parsed.searchParams.has('loadBalanced')
    || (expectedDatabase && database !== expectedDatabase)) {
    throw new Error(`${scriptName} requires an isolated local test MongoDB${expectedDatabase ? ` database named ${expectedDatabase}` : ''}`)
  }

  const port = parsed.port || '27017'
  return { url: parsed, database, host: parsed.hostname, port }
}

/**
 * Guard mutating scripts/test-runners so they only run under NODE_ENV=test
 * against the isolated local lexigrow_dev5_test database with an explicit opt-in flag.
 */
export function requireIsolatedTestExecution(scriptName, { envFlag, expectedDatabase = 'lexigrow_dev5_test' } = {}) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`${scriptName} is restricted to NODE_ENV=test`)
  }
  if (envFlag && process.env[envFlag] !== 'true') {
    throw new Error(`Set ${envFlag}=true to run this mutating script (${scriptName})`)
  }
  return assertLocalTestMongoUri(
    process.env.MONGO_URI || process.env.MONGODB_URI,
    scriptName,
    expectedDatabase,
  )
}
