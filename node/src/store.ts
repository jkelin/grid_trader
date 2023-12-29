import { uuidv7 } from "uuidv7";
import { Action, ReducerContext, State } from "./types.js";
import { List } from "immutable";
import { dheader } from "./helpers.js";

function printLevels(state: State) {
  console.log(
    dheader(),
    "Current level",
    state.currentLevelIndex,
    "BUY:",
    state.orders
      .filter((x) => x.side === "BUY")
      .map((x) => x.level)
      .toSorted((a, b) => a - b)
      .join(", "),
    "SELL:",
    state.orders
      .filter((x) => x.side === "SELL")
      .map((x) => x.level)
      .toSorted((a, b) => a - b)
      .join(", ")
  );
}

function printBalance(state: State) {
  console.log(
    dheader(),
    "USDT:",
    state.fdusd?.free,
    "+",
    state.fdusd?.locked,
    "; BTC:",
    state.btc?.free,
    "+",
    state.btc?.locked
  );
}

export function createStore(
  reducer: (action: Action, state: State, ctx: ReducerContext) => State,
  abort: AbortSignal
) {
  type InnerAction =
    | Action
    | {
        type: string;
        payload?: any;
      };

  let history = List<{
    timestamp: string;
    action?: InnerAction;
    state?: State;
  }>();

  let state: State = {
    currentLevelIndex: 0,
    targetTotalLevels: 10,
    orders: [],
  };

  function saveIntoHistory({
    state,
    action,
  }: {
    state?: State;
    action?: InnerAction;
  }) {
    history = history.withMutations((history) => {
      history.push({
        timestamp: new Date().toISOString(),
        action,
        state,
      });

      if (history.size > 1000) {
        history.shift();
      }
    });
  }

  saveIntoHistory({ state });

  async function handlePromises(
    promises: {
      name: string;
      generator: (...parameters: any[]) => Promise<unknown>;
      parameters: any[];
    }[],
    oldState: State,
    newState: State,
    action: Action
  ) {
    await Promise.all(
      promises.map(async ({ name, generator, parameters }) => {
        const id = uuidv7();
        try {
          saveIntoHistory({
            action: {
              type: `promise/${name}/started`,
              payload: {
                id,
                name,
                parameters,
                action,
                oldState,
                newState,
              },
            },
          });

          const resp = await generator(...parameters);

          saveIntoHistory({
            action: {
              type: `promise/${name}/finished`,
              payload: {
                id,
                name,
                parameters,
                resp,
              },
            },
          });
        } catch (error) {
          saveIntoHistory({
            action: {
              type: `promise/${name}/failed`,
              payload: {
                id,
                name,
                parameters,
                error,
              },
            },
          });

          console.error(
            dheader(),
            "Error while handling state change promise",
            {
              action,
              oldState,
              newState,
            }
          );
          throw error;
        }
      })
    );
  }

  const pendingActions: Action[] = [];

  function dispatch(action: Action) {
    if (abort.aborted) {
      return;
    }

    pendingActions.push(action);
    process.nextTick(processNextAction);
  }

  async function processNextAction() {
    const action = pendingActions.shift();

    if (action === undefined || abort.aborted) {
      return;
    }

    const currentState = state;
    try {
      const promises: {
        name: string;
        generator: (...parameters: any[]) => Promise<unknown>;
        parameters: any[];
      }[] = [];

      const newState = reducer(action, currentState, {
        promise: (name, generator, ...parameters) => {
          if (abort.aborted) {
            return;
          }

          promises.push({
            name,
            generator: generator as any,
            parameters: parameters as any,
          });
        },
        dispatch,
      });

      if (currentState.orders != newState.orders) {
        printLevels(newState);
      }

      if (currentState.btc != newState.btc || state.fdusd != newState.fdusd) {
        printBalance(newState);
      }

      state = newState;

      try {
        validateState(newState);
      } catch (err) {
        console.error(dheader(), "Invalid state", {
          err,
          action,
          currentState,
          newState,
        });
        throw err;
      }

      if (JSON.stringify(newState) !== JSON.stringify(currentState)) {
        // Do not store orderbook changes because there is way too many of them
        for (const keyStr in newState) {
          const key: keyof State = keyStr as any;
          if (currentState[key] === newState[key] || key === "lastTrade") {
            continue;
          }

          saveIntoHistory({ state: newState, action });
          break;
        }
      }

      await handlePromises(promises, currentState, newState, action);
    } catch (err) {
      console.error(dheader(), "Error while handling action", {
        err,
        action,
        state: currentState,
      });
      throw err;
    }
  }

  return {
    dispatch,
    getState() {
      return state;
    },
    getHistory() {
      return history.toArray();
    },
  };
}

export function isStateInitialized(state: State): state is Required<State> {
  return !!(
    state.levelSizeQuote &&
    state.currentLevelPrice &&
    state.fdusd &&
    state.btc &&
    state.lastTrade
  );
}

export function validateState(state: State) {
  // if (
  //   isStateInitialized(state) &&
  //   state.orders.length !== state.targetTotalLevels
  // ) {
  //   throw new Error("state.orders.length must be equal to targetTotalLevels");
  // }
}
