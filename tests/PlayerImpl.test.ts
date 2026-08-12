import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let player: Player;
let other: Player;

describe("PlayerImpl", () => {
  beforeEach(async () => {
    game = await setup(
      "plains",
      {
        instantBuild: true,
      },
      [
        new PlayerInfo("player", PlayerType.Human, null, "player_id"),
        new PlayerInfo("other", PlayerType.Human, null, "other_id"),
      ],
    );

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    player = game.player("player_id");
    other = game.player("other_id");

    player.conquer(game.ref(0, 0));
    other.conquer(game.ref(50, 50));
    player.addGold(BigInt(1000000));

    game.config().structureMinDist = () => 10;
  });

  test("City can be upgraded", () => {
    const city = player.buildUnit(UnitType.City, game.ref(0, 0), {});
    const buCity = player
      .buildableUnits(game.ref(0, 0))
      .find((bu) => bu.type === UnitType.City);
    expect(buCity).toBeDefined();
    expect(buCity!.canUpgrade).toBe(city.id());
  });

  test("DefensePost cannot be upgraded", () => {
    player.buildUnit(UnitType.DefensePost, game.ref(0, 0), {});
    const buDefensePost = player
      .buildableUnits(game.ref(0, 0))
      .find((bu) => bu.type === UnitType.DefensePost);
    expect(buDefensePost).toBeDefined();
    expect(buDefensePost!.canUpgrade).toBeFalsy();
  });

  test("City can be upgraded from another city", () => {
    const city = player.buildUnit(UnitType.City, game.ref(0, 0), {});
    const cityToUpgrade = player.findUnitToUpgrade(
      UnitType.City,
      game.ref(0, 1),
    );
    expect(cityToUpgrade).toBeTruthy();
    if (cityToUpgrade === false) {
      return;
    }
    expect(cityToUpgrade.id()).toBe(city.id());
  });
  test("City cannot be upgraded when too far away", () => {
    player.buildUnit(UnitType.City, game.ref(0, 0), {});
    const cityToUpgrade = player.findUnitToUpgrade(
      UnitType.City,
      game.ref(50, 50),
    );
    expect(cityToUpgrade).toBe(false);
  });
  test("Unit cannot be upgraded when not enough gold", () => {
    player.buildUnit(UnitType.City, game.ref(0, 0), {});
    player.removeGold(BigInt(1000000));
    const cityToUpgrade = player.findUnitToUpgrade(
      UnitType.City,
      game.ref(0, 1),
    );
    expect(cityToUpgrade).toBe(false);
  });

  test("Can't send alliance requests when dead", () => {
    // conquer other
    const otherTiles = Array.from(other.tiles());
    for (const tile of otherTiles) {
      player.conquer(tile);
    }
    expect(other.canSendAllianceRequest(player)).toBe(false);
  });

  test("tiles returns a live runtime-read-only view", () => {
    const tiles = player.tiles();
    const tile = game.ref(50, 50);

    expect(player.tiles()).toBe(tiles);
    expect(tiles.has(tile)).toBe(false);
    player.conquer(tile);
    expect(tiles.has(tile)).toBe(true);
    expect(() => (tiles as Set<number>).clear()).toThrow(TypeError);
    expect(game.owner(tile)).toBe(player);
  });

  test("tiles iteration stays bounded when the current tile is reconquered", () => {
    const expected = Array.from(player.tiles());
    const visited: number[] = [];

    for (const tile of player.tiles()) {
      visited.push(tile);
      if (visited.length > expected.length) break;
      player.conquer(tile);
    }

    expect(visited).toEqual(expected);
  });
});
