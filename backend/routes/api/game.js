const express = require("express");
const Games = require("../../db/games");
const { GAME_CREATED } = require("../../../shared/constants");

const router = express.Router();

router.get("/list", async (request, response) => {
  const { id: user_id } = request.session.user;

  try {
    const games = await Games.list(user_id);

    response.json({ games });
  } catch (error) {
    console.log({ error });

    response.redirect("/lobby");
  }
});

router.post("/create", async (request, response) => {
  const { game_title, number_of_players } = request.body;
  const { id: user_id } = request.session.user;
  const io = request.app.get("io");

  try {
    const { game_id } = await Games.create(
      user_id,
      game_title,
      number_of_players
    );

    io.emit(GAME_CREATED, { game_id, game_title });

    response.redirect(`/games/${game_id}/waiting-room`);
  } catch (error) {
    console.log({ error });

    response.redirect("/lobby");
  }
});

router.get("/:id/join", async (request, response) => {
  const { id: game_id } = request.params;
  const { id: user_id } = request.session.user;

  try {
    await Games.join(user_id, game_id);

    response.redirect(`/games/${game_id}/waiting-room`);
  } catch (error) {
    console.log({ error });

    response.redirect("/lobby");
  }
});

router.post("/:id/submit-word", async (request, response) => {
  const { id: game_id } = request.params;
  const { id: user_id } = request.session.user;
  const io = request.app.get("io");

  const tilesPlayed = request.body;

  try {
    // TODO: check if the player can make a turn
    // TODO: ensure user has the tiles that were played

    // update game tiles table with each tile placed
    tilesPlayed.forEach(async (tilePlayed) => {
      // user_id is 0 as it is placed on the board
      await Games.updateGameTiles(
        game_id,
        0,
        tilePlayed.canonicalTileID,
        tilePlayed.boardX,
        tilePlayed.boardY
      );
    });

    // get and set new current player & emit to room
    const newCurrentPlayer = await Games.setAndGetNewCurrentPlayer(game_id);
    io.sockets.in(game_id).emit("current-player", newCurrentPlayer);

    // emit the added tiles to the room
    io.sockets.in(game_id).emit("board-updated", tilesPlayed);

    response.status(200).send("placeholder");
  } catch (error) {
    console.log(error);
    response.status(500);
  }
});

module.exports = router;
