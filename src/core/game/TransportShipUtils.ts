import { SpatialQuery } from "../pathfinding/spatial/SpatialQuery";
import { Game, Player, UnitType } from "./Game";
import { TileRef } from "./GameMap";

const spatialQueries = new WeakMap<Game, SpatialQuery>();

function spatialQuery(game: Game): SpatialQuery {
  let spatial = spatialQueries.get(game);
  if (spatial === undefined) {
    spatial = new SpatialQuery(game);
    spatialQueries.set(game, spatial);
  }
  return spatial;
}

export function canBuildTransportShip(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (
    player.unitCount(UnitType.TransportShip) >= game.config().boatMaxNumber()
  ) {
    return false;
  }

  const dst = targetTransportTile(game, tile);
  if (dst === null) {
    return false;
  }

  const other = game.owner(tile);
  if (other === player) {
    return false;
  }
  if (other.isPlayer() && !player.canAttackPlayer(other)) {
    return false;
  }

  return spatialQuery(game).closestShoreByWater(player, dst) ?? false;
}

export function targetTransportTile(gm: Game, tile: TileRef): TileRef | null {
  return spatialQuery(gm).closestShore(gm.owner(tile), tile);
}

export function bestShoreDeploymentSource(
  gm: Game,
  player: Player,
  dst: TileRef,
): TileRef | null {
  return spatialQuery(gm).closestShoreByWater(player, dst);
}
