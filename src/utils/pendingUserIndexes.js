// Creating the new index alone leaves MongoDB's old createdAt TTL active.
// Remove only that legacy TTL; preserve unrelated indexes.
export async function syncPendingUserExpiryIndexes(collection) {
  // Separate name also permits coexistence with a legacy non-unique email index.
  // Duplicate historical records must be resolved before serving registration.
  await collection.createIndex({ email: 1 }, { unique: true, name: 'pending_email_unique' })
  await collection.createIndex({ verificationCodeExpire: 1 }, { expireAfterSeconds: 0 })
  const indexes = await collection.listIndexes().toArray()
  for (const index of indexes) {
    if (Object.keys(index.key).length === 1 && index.key.createdAt === 1
      && index.expireAfterSeconds !== undefined) {
      await collection.dropIndex(index.name)
    }
  }
}
