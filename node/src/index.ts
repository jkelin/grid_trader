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
import { dheader } from "./helpers.js";

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

    console.log(dheader(), "Wrting logs into", filename);

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
    console.log(dheader(), "Failed to save logs", err);
  }
}

function registerStatusHandler(store: ReturnType<typeof createStore>) {
  fastify.get("/", {
    async handler(request, reply) {
      const state = store.getState();
      return {
        equity:
          state.fdusd &&
          state.btc &&
          state.lastTrade &&
          state.fdusd.free
            .add(state.fdusd.locked)
            .add(state.btc.free.times(state.lastTrade.price))
            .add(state.btc.locked.times(state.lastTrade.price)),
        state: state,
      };
    },
  });
}

async function main() {
  console.info(dheader(), "Starting");

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
        console.error(dheader(), "Error", err);
      }

      console.info(dheader(), "Stopping");
      try {
        abortController.abort();
        binanceSocketClient.closeAll();
        await Promise.all([closeAll(), saveLogs(store), fastify.close()]);
      } catch (err) {
        console.error(dheader(), "Error while closing app", err);
      }

      console.log(dheader(), "All done");
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
    binanceSocketClient.subscribeAggregateTrades("BTCFDUSD", "spot"),
  ]);

  console.info(dheader(), "Started");
}

await main();
