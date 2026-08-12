import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Structures,
  UnitType,
} from "../src/core/game/Game";
import { TileRef } from "../src/core/game/GameMap";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { setup } from "./util/Setup";

let game: Game;
let player: Player;
let other: Player;

function legacyLandStructureSpawn(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (game.owner(tile) !== player) {
    return false;
  }
  const searchRadius = 15;
  const searchRadiusSquared = searchRadius ** 2;
  const nearbyUnits = game.nearbyUnits(
    tile,
    searchRadius * 2,
    Structures.types,
    undefined,
    true,
  );
  const nearbyTiles = game.bfs(tile, (map, candidate) => {
    return (
      game.euclideanDistSquared(tile, candidate) < searchRadiusSquared &&
      map.ownerID(candidate) === player.smallID()
    );
  });
  const validSet = new Set(nearbyTiles);
  const minDistSquared = game.config().structureMinDist() ** 2;

  for (const candidate of nearbyTiles) {
    for (const { unit } of nearbyUnits) {
      if (game.euclideanDistSquared(unit.tile(), candidate) < minDistSquared) {
        validSet.delete(candidate);
        break;
      }
    }
  }

  const valid = Array.from(validSet);
  valid.sort(
    (a, b) =>
      game.euclideanDistSquared(a, tile) - game.euclideanDistSquared(b, tile),
  );
  return valid[0] ?? false;
}

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

  test.each([
    [11, 4],
    [29, 7],
    [101, 10],
  ])(
    "matches the legacy structure spawn selection for seed %i",
    (seed, minStructureDistance) => {
      const random = new PseudoRandom(seed);
      game.config().structureMinDist = () => minStructureDistance;

      for (let x = 15; x <= 85; x++) {
        for (let y = 15; y <= 85; y++) {
          player.conquer(game.ref(x, y));
        }
      }

      const tieTarget = game.ref(25, 25);
      const randomTargets = new Set<TileRef>();
      while (randomTargets.size < 10) {
        randomTargets.add(
          game.ref(random.nextInt(58, 76), random.nextInt(58, 76)),
        );
      }

      const ownershipHoles = new Set<TileRef>();
      while (ownershipHoles.size < 45) {
        const hole = game.ref(random.nextInt(52, 82), random.nextInt(52, 82));
        if (!randomTargets.has(hole)) {
          ownershipHoles.add(hole);
        }
      }
      for (const hole of ownershipHoles) {
        other.conquer(hole);
      }

      player.addGold(1_000_000_000_000n);
      const tieBlocker = player.buildUnit(UnitType.City, tieTarget, {});
      tieBlocker.setUnderConstruction(true);
      for (const target of randomTargets) {
        player.buildUnit(UnitType.City, target, {});
      }

      const unownedTarget = game.ref(8, 8);
      other.conquer(unownedTarget);
      const targets = [tieTarget, ...randomTargets, unownedTarget];

      for (const target of targets) {
        const legacy = legacyLandStructureSpawn(game, player, target);
        expect(player.canBuild(UnitType.DefensePost, target)).toBe(legacy);
        expect(
          player.buildableUnits(target, [UnitType.DefensePost])[0].canBuild,
        ).toBe(legacy);
      }

      const legacyTie = legacyLandStructureSpawn(game, player, tieTarget);
      expect(legacyTie).not.toBe(false);
      expect([
        game.ref(25, 25 - minStructureDistance),
        game.ref(25, 25 + minStructureDistance),
        game.ref(25 - minStructureDistance, 25),
        game.ref(25 + minStructureDistance, 25),
      ]).toContain(legacyTie);
      expect(
        player.canBuild(UnitType.DefensePost, unownedTarget, [tieTarget]),
      ).toBe(tieTarget);
    },
  );

  test("Can't send alliance requests when dead", () => {
    // conquer other
    const otherTiles = other.tiles();
    for (const tile of otherTiles) {
      player.conquer(tile);
    }
    expect(other.canSendAllianceRequest(player)).toBe(false);
  });
});
