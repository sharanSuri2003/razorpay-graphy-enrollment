import test from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { ensureIndexes } from "../src/mongo.js";

let started;

function start() {
  if (!started) {
    started = (async () => {
      const mongod = await MongoMemoryServer.create();
      const client = new MongoClient(mongod.getUri());
      await client.connect();
      return { mongod, client };
    })();
  }
  return started;
}

export async function stopMongo() {
  if (!started) return;
  const current = started;
  started = undefined;
  const { mongod, client } = await current;
  await client.close();
  await mongod.stop();
}

/** Call from each test file that uses createTestDb. Files run one at a time. */
export function closeMongoAfterTests() {
  test.after(async () => {
    await stopMongo();
  });
}

export async function createTestDb() {
  const { client } = await start();
  const name = `t_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
  const db = client.db(name);
  await ensureIndexes(db);
  return db;
}
