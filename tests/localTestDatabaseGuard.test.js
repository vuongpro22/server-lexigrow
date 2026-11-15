import { afterEach, describe, expect, it } from 'vitest'
import { assertLocalTestMongoUri, assertTestApiIdentity, requireIsolatedTestExecution } from '../scripts/localTestDatabaseGuard.js'

const origEnv = { ...process.env }

afterEach(() => {
  process.env = { ...origEnv }
})

describe('local test MongoDB guard', () => {
  it('accepts only a local isolated test database', () => {
    expect(assertLocalTestMongoUri('mongodb://127.0.0.1:27017/lexigrow_dev5_test', 'runner', 'lexigrow_dev5_test')).toMatchObject({
      database: 'lexigrow_dev5_test',
      host: '127.0.0.1',
      port: '27017',
    })
  })

  it.each([
    'mongodb://evil.example/lexigrow_test?x=localhost',
    'mongodb://localhost/production',
    'mongodb+srv://localhost/lexigrow_test',
    'mongodb://localhost/lexigrow_test?replicaSet=rs0',
    'mongodb://localhost/lexigrow_test?loadBalanced=true',
  ])('rejects unsafe or non-test URI %s', (uri) => {
    expect(() => assertLocalTestMongoUri(uri, 'runner')).toThrow()
  })

  it('requires an explicitly expected database when given', () => {
    expect(() => assertLocalTestMongoUri('mongodb://localhost/other_test', 'runner', 'lexigrow_test')).toThrow()
  })

  it('accepts API identity only when database host, port, and name match', () => {
    expect(() => assertTestApiIdentity({
      environment: 'test', database: 'lexigrow_dev5_test', databaseHost: '127.0.0.1', databasePort: '27017',
    }, { database: 'lexigrow_dev5_test', host: '127.0.0.1', port: '27017' })).not.toThrow()
    expect(() => assertTestApiIdentity({
      environment: 'test', database: 'production', databaseHost: '127.0.0.1', databasePort: '27017',
    }, { database: 'lexigrow_dev5_test', host: '127.0.0.1', port: '27017' })).toThrow()
  })

  it('requires NODE_ENV=test, confirmation flag, and isolated DB for mutating scripts', () => {
    process.env.NODE_ENV = 'development'
    process.env.RUN_DEMO = 'true'
    process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lexigrow_dev5_test'
    expect(() => requireIsolatedTestExecution('demoScript', { envFlag: 'RUN_DEMO' })).toThrow(/NODE_ENV=test/)

    process.env.NODE_ENV = 'test'
    delete process.env.RUN_DEMO
    expect(() => requireIsolatedTestExecution('demoScript', { envFlag: 'RUN_DEMO' })).toThrow(/RUN_DEMO=true/)

    process.env.RUN_DEMO = 'true'
    process.env.MONGO_URI = 'mongodb://100.120.185.49:27017/lexigrow'
    expect(() => requireIsolatedTestExecution('demoScript', { envFlag: 'RUN_DEMO' })).toThrow(/isolated local test MongoDB/)

    process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lexigrow_dev5_test'
    expect(requireIsolatedTestExecution('demoScript', { envFlag: 'RUN_DEMO' }).database).toBe('lexigrow_dev5_test')
  })
})
