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

export async function createTestDb() {
  const { client } = await start();
  const name = `t_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
  const db = client.db(name);
  await ensureIndexes(db);
  return db;
}
