import Fastify from "fastify";
import fs from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { format } from "date-fns";
import closeWithGrace from "close-with-grace";
import { fileURLToPath } from "url";
import { createStore } from "./store.js";
import { reducer } from "./reducer.js";
import {
  binanceSocketClient,
  closeAll,
  fetchBalance,
  keepUpdatingSettingsFromAPI,
} from "./client.js";

const fastify = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  },
});

async function saveLogs(store: ReturnType<typeof createStore>) {
  try {
    const logs = JSON.stringify(store.getHistory(), null, 2);

    const filename = resolve(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "logs",
        format(new Date(), "yyyy-MM-dd'T'HH-mm-ss'.json'")
      )
    );

    console.log("Wrting logs into", filename);

    try {
      await fs.mkdir(filename.replace(basename(filename), ""), {
        recursive: true,
      });
    } catch (err) {
      if ((err as any).code !== "EEXIST") {
        throw new Error(`Failed to create logs folder ${(err as any).message}`);
      }
    }

    await fs.writeFile(filename, logs, "utf-8");
  } catch (err) {
    console.log("Failed to save logs", err);
  }
}

function registerStatusHandler(store: ReturnType<typeof createStore>) {
  fastify.get("/", {
    async handler(request, reply) {
      const state = store.getState();
      return {
        equity:
          state.tusd &&
          state.btc &&
          state.lastTrade &&
          state.tusd.free
            .add(state.tusd.locked)
            .add(state.btc.free.times(state.lastTrade.price))
            .add(state.btc.locked.times(state.lastTrade.price)),
        state: state,
      };
    },
  });
}

async function main() {
  console.info("Starting");

  const abortController = new AbortController();
  const store = createStore(reducer, abortController.signal);

  registerStatusHandler(store);

  await fastify.listen({
    port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
    host: "0.0.0.0",
  });

  const close = closeWithGrace(
    {
      delay: 5000,
    },
    async ({ signal, err, manual }) => {
      if (err) {
        console.error("Error", err);
      }

      console.info("Stopping");
      try {
        abortController.abort();
        binanceSocketClient.closeAll();
        await Promise.all([closeAll(), saveLogs(store), fastify.close()]);
      } catch (err) {
        console.error("Error while closing", err);
      }

      console.log("All done");
    }
  );

  // setTimeout(() => {
  //   console.log("Periodic close");
  //   close.close();
  // }, 10 * 60 * 1000);

  await closeAll();

  keepUpdatingSettingsFromAPI(store.dispatch, abortController.signal);

  const balances = await fetchBalance();
  store.dispatch({
    type: "updateBalance",
    payload: balances,
  });

  binanceSocketClient.on("formattedMessage", (data) => {
    if (abortController.signal.aborted) {
      return;
    }

    store.dispatch({
      type: "ws",
      payload: data,
    });
  });

  await Promise.all([
    binanceSocketClient.subscribeMarginUserDataStream(),
    binanceSocketClient.subscribeAggregateTrades("BTCTUSD", "spot"),
  ]);

  console.info("Started");
}

await main();
