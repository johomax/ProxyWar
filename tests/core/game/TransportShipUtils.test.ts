import { afterEach, describe, expect, it, vi } from "vitest";
import { targetTransportTile } from "../../../src/core/game/TransportShipUtils";
import { SpatialQuery } from "../../../src/core/pathfinding/spatial/SpatialQuery";
import { createGame, createIslandMap } from "../pathfinding/_fixtures";

describe("TransportShipUtils", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses one SpatialQuery per game", () => {
    const closestShore = vi.spyOn(SpatialQuery.prototype, "closestShore");
    const firstGame = createGame(createIslandMap());
    const secondGame = createGame(createIslandMap());
    const tile = firstGame.ref(2, 2);

    targetTransportTile(firstGame, tile);
    targetTransportTile(firstGame, tile);
    targetTransportTile(secondGame, secondGame.ref(2, 2));

    expect(closestShore.mock.instances[0]).toBe(closestShore.mock.instances[1]);
    expect(closestShore.mock.instances[2]).not.toBe(
      closestShore.mock.instances[0],
    );
  });
});
