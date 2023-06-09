const express = require("express");

const Games = require("../../db/games");
const Users = require("../../db/users");
const GameUsers = require("../../db/game_users");
const GameTiles = require("../../db/game_tiles");
const Board = require("../../db/board");
const CanonicalTiles = require("../../db/canonical_tiles");

const { GAME_CREATED } = require("../../../shared/constants");

const router = express.Router();

const scrabbleWords = require("../../scrabbleWords");

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
    const { game_id } = await Games.create(game_title, number_of_players);

    await GameUsers.insertUserInGame(game_id, user_id, true, 1);

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
  const io = request.app.get("io");

  try {
    // don't allow join if number of players matches player count of game
    const numberOfPlayers = await GameUsers.getNumberOfPlayers(game_id);
    const playerCount = (await Games.gameInformation(game_id)).player_count;
    if (numberOfPlayers == playerCount) {
      return response.redirect(`/lobby`);
    }

    // don't allow join if game has started already
    if (await Games.checkGameStarted(game_id)) {
      return response.redirect(`/lobby`);
    }

    await GameUsers.insertUserInGame(
      game_id,
      user_id,
      false,
      parseInt(numberOfPlayers) + 1
    );

    const usersInformation = await Users.information(user_id);

    // emit to everyone in the game room that the user joined the waiting list
    io.sockets
      .in(game_id)
      .emit("joined-waiting-list", usersInformation.username);

    response.redirect(`/games/${game_id}/waiting-room`);
  } catch (error) {
    console.log({ error });

    response.redirect("/lobby");
  }
});

// returns the tiles that were taken from the bag and given to the user
const giveTilesFromBagToUser = async (
  userID,
  gameID,
  numberOfTilesRequested
) => {
  // numberOfTilesInBag = number of tiles in the bag
  const numberOfTilesInBag = await GameTiles.getNumberOfTilesInBag(gameID);

  // if numberOfTilesRequested > numberOfTilesInBag, return getTilesFromBag(userID, gameID, numberOfTilesInBag)
  if (numberOfTilesRequested > numberOfTilesInBag) {
    return giveTilesFromBagToUser(userId, gameID, numberOfTilesInBag);
  }

  const tilesFromBag = await GameTiles.getTilesFromBag(
    gameID,
    numberOfTilesRequested
  );
  const arrayOfTilesFromBag = [];
  tilesFromBag.forEach((tileFromBag) => {
    arrayOfTilesFromBag.push(tileFromBag.tile_id);
  });

  const newTileIDsForPlayer = await GameTiles.giveTilesFromBagToUser(
    userID,
    gameID,
    arrayOfTilesFromBag
  );
  const arrayOfTileIdsForPlayer = [];
  newTileIDsForPlayer.forEach((newTileIDForPlayer) => {
    arrayOfTileIdsForPlayer.push(newTileIDForPlayer.tile_id);
  });

  const canonicalInformationAboutTiles =
    await CanonicalTiles.canonicalInformationAboutTiles(
      arrayOfTileIdsForPlayer
    );

  return canonicalInformationAboutTiles;
};

// returns true if user has all of the tiles on their rack; false otherwise
// expects tiles to be an array of objects, and idAttribute to be the attribute
// of each object being the key of the tile ID
const ensureUserHasTiles = async (userID, gameID, tiles, idAttribute) => {
  for (let i = 0; i < tiles.length; i++) {
    const tile_id = tiles[i][idAttribute];
    const userHasTile = await GameTiles.checkUserHasTile(
      userID,
      gameID,
      tile_id
    );
    if (!userHasTile) {
      return false;
    }
  }

  return true;
};

const ensureUserInGame = async (userID, gameID) => {
  const playerInGame = await GameUsers.playerInGame(userID, gameID);
  return playerInGame[0].exists;
};

const ensureUserCanMakeTurn = async (userID, gameID) => {
  const userCanMakeTurn = await GameUsers.userCanMakeTurn(userID, gameID);
  return userCanMakeTurn[0].exists;
};

// returns h if horizontal, v if vertical
const getWordDirection = (tilesPlayed) => {
  const minRow = tilesPlayed.reduce((previous, current) => {
    return previous.boardX < current.boardX ? previous : current;
  }).boardX;

  const maxRow = tilesPlayed.reduce((previous, current) => {
    return previous.boardX > current.boardX ? previous : current;
  }).boardX;

  const minCol = tilesPlayed.reduce((previous, current) => {
    return previous.boardY < current.boardY ? previous : current;
  }).boardY;

  const maxCol = tilesPlayed.reduce((previous, current) => {
    return previous.boardY > current.boardY ? previous : current;
  }).boardY;

  // based on min and max values, determine direction of word
  if (minRow == maxRow) {
    return { direction: "h", minCol: minCol, maxCol: maxCol, wordRow: minRow };
  } else if (minCol == maxCol) {
    return { direction: "v", minRow: minRow, maxRow: maxRow, wordCol: minCol };
  } else {
    throw new Error("Word must be in the horizontal or vertical direction!");
  }
};

// checks that tile positions aren't taken already, and that the
// tiles touch at least one existing tile on the board
const verifyTilePositions = async (game_id, tilesPlayed) => {
  let touchesExistingTile = false;

  for (const tilePlayed of tilesPlayed) {
    // ensure board position of tile isn't taken already
    const positionTaken = await GameTiles.tileOnBoardAlready(
      game_id,
      tilePlayed.boardX,
      tilePlayed.boardY
    );
    if (positionTaken) {
      throw new Error("Board position of tile taken already!");
    }

    // check if current tile touches existing tile on board,
    // if none of previous tiles touched existing tiles
    if (!touchesExistingTile) {
      const leftCheck = await GameTiles.tileOnBoardAlready(
        game_id,
        tilePlayed.boardX,
        tilePlayed.boardY - 1
      );
      const upCheck = await GameTiles.tileOnBoardAlready(
        game_id,
        tilePlayed.boardX - 1,
        tilePlayed.boardY
      );
      const rightCheck = await GameTiles.tileOnBoardAlready(
        game_id,
        tilePlayed.boardX,
        tilePlayed.boardY + 1
      );
      const downCheck = await GameTiles.tileOnBoardAlready(
        game_id,
        tilePlayed.boardX + 1,
        tilePlayed.boardY
      );

      if (leftCheck || upCheck || rightCheck || downCheck) {
        // set to true to prevent doing check for a later tile
        touchesExistingTile = true;
      }
    }
  }

  // if every tile in word placed doesn't touch existing tiles on board
  if (!touchesExistingTile) {
    throw new Error("Word doesn't touch existing tiles!");
  }
};

const buildHorizontalWord = async (
  game_id,
  wordDirection,
  tilesPlayed,
  idsOfTilesOnBoardAlready
) => {
  let word = "";

  // check the left of the first tile for any board tiles
  // leftmost tile: (wordDirection.wordRow, wordDirection.minCol)
  for (let i = wordDirection.minCol - 1; i >= 0; i--) {
    const tileOnBoardAlready = await GameTiles.tileOnBoardAlready(
      game_id,
      wordDirection.wordRow,
      i
    );
    if (tileOnBoardAlready) {
      const tileOnBoard = await GameTiles.getTileOnGameBoard(
        game_id,
        wordDirection.wordRow,
        i
      );
      idsOfTilesOnBoardAlready.push(tileOnBoard.tile_id);
      word = tileOnBoard.letter + word;
    } else {
      break;
    }
  }

  // there must be a tile in each column represented by i; if no tile in either
  // tilesPlayed or DB, fail
  for (let i = wordDirection.minCol; i <= wordDirection.maxCol; i++) {
    // check in tilesPlayed & DB for the tile
    const tilePlayedResult = tilesPlayed.find(
      (tilePlayed) => tilePlayed.boardY == i
    );
    const dbResult = await GameTiles.tileOnBoardAlready(
      game_id,
      wordDirection.wordRow,
      i
    );
    if (tilePlayedResult == undefined && !dbResult) {
      throw new Error("Word isn't continuous along the horizontal direction!");
    } else if (tilePlayedResult != undefined) {
      word += tilePlayedResult.letter;
    } else {
      // tile is on board already

      // get tile from DB
      const tileLetter = await GameTiles.getTileOnGameBoard(
        game_id,
        wordDirection.wordRow,
        i
      );
      idsOfTilesOnBoardAlready.push(tileLetter.tile_id);
      word += tileLetter.letter;
    }
  }

  // check the right of the last tile for any board tiles
  // rightmost tile: (wordDirection.wordRow, wordDirection.maxCol)
  for (let i = wordDirection.maxCol + 1; i <= 14; i++) {
    const tileOnBoardAlready = await GameTiles.tileOnBoardAlready(
      game_id,
      wordDirection.wordRow,
      i
    );
    if (tileOnBoardAlready) {
      const tileOnBoard = await GameTiles.getTileOnGameBoard(
        game_id,
        wordDirection.wordRow,
        i
      );
      idsOfTilesOnBoardAlready.push(tileOnBoard.tile_id);
      word += tileOnBoard.letter;
    } else {
      break;
    }
  }

  return word;
};

const buildVerticalWord = async (
  game_id,
  wordDirection,
  tilesPlayed,
  idsOfTilesOnBoardAlready
) => {
  let word = "";

  // check above the abovemost tile for any board tiles
  // abovemost tile: (wordDirection.minRow, wordDirection.wordCol)
  for (let i = wordDirection.minRow - 1; i >= 0; i--) {
    const tileOnBoardAlready = await GameTiles.tileOnBoardAlready(
      game_id,
      i,
      wordDirection.wordCol
    );
    if (tileOnBoardAlready) {
      const tileOnBoard = await GameTiles.getTileOnGameBoard(
        game_id,
        i,
        wordDirection.wordCol
      );
      idsOfTilesOnBoardAlready.push(tileOnBoard.tile_id);
      word = tileOnBoard.letter + word;
    } else {
      break;
    }
  }

  // there must be a tile in each row represented by i; if no tile in either
  // tilesPlayed or DB, fail
  for (let i = wordDirection.minRow; i <= wordDirection.maxRow; i++) {
    // check in tilesPlayed & DB for the tile
    const tilePlayedResult = tilesPlayed.find(
      (tilePlayed) => tilePlayed.boardX == i
    );
    const dbResult = await GameTiles.tileOnBoardAlready(
      game_id,
      i,
      wordDirection.wordCol
    );

    if (tilePlayedResult == undefined && !dbResult) {
      throw new Error("Word isn't continuous along the vertical direction!");
    } else if (tilePlayedResult != undefined) {
      word += tilePlayedResult.letter;
    } else {
      // tile is on board already
      const tileLetter = await GameTiles.getTileOnGameBoard(
        game_id,
        i,
        wordDirection.wordCol
      );
      idsOfTilesOnBoardAlready.push(tileLetter.tile_id);
      word += tileLetter.letter;
    }
  }

  // check below the belowmost tile for any board tiles
  // belowmost tile: (wordDirection.maxRow, wordDirection.wordCol)
  for (let i = wordDirection.maxRow + 1; i <= 14; i++) {
    const tileOnBoardAlready = await GameTiles.tileOnBoardAlready(
      game_id,
      i,
      wordDirection.wordCol
    );
    if (tileOnBoardAlready) {
      const tileOnBoard = await GameTiles.getTileOnGameBoard(
        game_id,
        i,
        wordDirection.wordCol
      );
      idsOfTilesOnBoardAlready.push(tileOnBoard.tile_id);
      word += tileOnBoard.letter;
    } else {
      break;
    }
  }

  return word;
};

const buildWord = async (game_id, tilesPlayed) => {
  const wordDirection = getWordDirection(tilesPlayed);

  let word = "";
  const idsOfTilesOnBoardAlready = [];

  // if only one tile is played, it can either be in the horizontal or vertical direction
  if (tilesPlayed.length == 1) {
    const horizontalWord = await buildHorizontalWord(
      game_id,
      {
        direction: "h",
        minCol: tilesPlayed[0].boardY,
        maxCol: tilesPlayed[0].boardY,
        wordRow: tilesPlayed[0].boardX,
      },
      tilesPlayed,
      idsOfTilesOnBoardAlready
    );

    const verticalWord = await buildVerticalWord(
      game_id,
      {
        direction: "v",
        minRow: tilesPlayed[0].boardX,
        maxRow: tilesPlayed[0].boardX,
        wordCol: tilesPlayed[0].boardY,
      },
      tilesPlayed,
      idsOfTilesOnBoardAlready
    );

    if (horizontalWord.length > verticalWord.length) {
      word = horizontalWord;
    } else {
      word = verticalWord;
    }
  } else {
    if (wordDirection.direction == "h") {
      // build the word horizontally
      word = await buildHorizontalWord(
        game_id,
        wordDirection,
        tilesPlayed,
        idsOfTilesOnBoardAlready
      );
    } else if (wordDirection.direction == "v") {
      // build the word vertically
      word = await buildVerticalWord(
        game_id,
        wordDirection,
        tilesPlayed,
        idsOfTilesOnBoardAlready
      );
    }
  }

  return { word, idsOfTilesOnBoardAlready };
};

const giveTurnToNextPlayer = async (game_id, io) => {
  const currentPlayer = await GameUsers.getCurrentPlayerOfGame(game_id);

  // get the current player's play order
  let currentPlayerPlayOrder = currentPlayer.play_order;

  // set current player's current field to false
  await GameUsers.setCurrentPlayerOfGame(false, game_id, currentPlayer.user_id);

  // get number of players in the game
  const numberOfPlayers = await GameUsers.getNumberOfPlayers(game_id);

  // get play order of new current non-resigned player
  do {
    if (currentPlayerPlayOrder == numberOfPlayers) {
      currentPlayerPlayOrder = 1;
    } else {
      currentPlayerPlayOrder = currentPlayerPlayOrder + 1;
    }
  } while (
    (
      await GameUsers.getInformationGivenPlayOrder(
        game_id,
        currentPlayerPlayOrder
      )
    ).resigned
  );

  // get id of this new current player
  const userIdOfNewCurrentPlayer = (
    await GameUsers.getInformationGivenPlayOrder(
      game_id,
      currentPlayerPlayOrder
    )
  ).user_id;

  // set new current player
  await GameUsers.setCurrentPlayerOfGame(
    true,
    game_id,
    userIdOfNewCurrentPlayer
  );

  io.sockets.in(game_id).emit("current-player", userIdOfNewCurrentPlayer);
};

router.post("/:id/submit-word", async (request, response) => {
  const { id: game_id } = request.params;
  const { id: user_id } = request.session.user;
  const io = request.app.get("io");

  const tilesPlayed = request.body;

  // edge case if player clicks button without placing any tiles
  if (tilesPlayed.length == 0) {
    return response.status(200).send({});
  }

  try {
    // ensure player is in the game
    const userInGame = await ensureUserInGame(user_id, game_id);
    if (!userInGame) {
      throw new Error("User not in game!");
    }

    // check if the player can make a turn
    const userCanMakeTurn = await ensureUserCanMakeTurn(user_id, game_id);
    if (!userCanMakeTurn) {
      throw new Error("User can't make turn!");
    }

    // ensure user has the tiles that were played
    const userHasTiles = await ensureUserHasTiles(
      user_id,
      game_id,
      tilesPlayed,
      "canonicalTileID"
    );
    if (!userHasTiles) {
      throw new Error("User doesn't have the tiles!");
    }

    // ----- check that tiles comply with Scrabble rules -----

    // if first word already placed on board, verify tile positions not taken
    // and that at least one tile touches existing tiles on board
    const firstWordPlaced = await Games.firstWordPlacedInGame(game_id);
    if (firstWordPlaced) {
      await verifyTilePositions(game_id, tilesPlayed).catch((error) => {
        throw error;
      });
    }

    // build word
    let { word, idsOfTilesOnBoardAlready } = await buildWord(
      game_id,
      tilesPlayed
    );

    // check if word is valid (in the Scrabble dictionary)
    word = word.replace(/\s/g, ""); // replace spaces with non-spaces
    if (!scrabbleWords.has(word)) {
      throw new Error(`${word} isn't a valid word.`);
    }

    // if first word placed is false in DB, set to true
    if (!firstWordPlaced) {
      await Games.setFirstWordPlacedToTrue(game_id);
    }

    // track total score, to accurately give word multiplier rewards
    let totalScore = 0;

    // add scores of tiles already placed on board
    for (let i = 0; i < idsOfTilesOnBoardAlready.length; i++) {
      const tileValue = await CanonicalTiles.getTilePointValue(
        idsOfTilesOnBoardAlready[i]
      );
      totalScore += tileValue;
    }

    // will be used to multiply totalScore
    let wordMultiplier = 1;

    // update game tiles table with each tile placed & multiply based on special tiles
    for (const tilePlayed of tilesPlayed) {
      // user_id is 0 as it is placed on the board
      await GameTiles.updateGameTiles(
        game_id,
        0,
        tilePlayed.canonicalTileID,
        tilePlayed.boardX,
        tilePlayed.boardY
      );

      // get letter and word multiplier of tile position
      const letterAndWordMultiplier =
        await Board.getLetterAndWordMultiplierOfPosition(
          tilePlayed.boardX,
          tilePlayed.boardY
        );

      // set word multiplier
      if (letterAndWordMultiplier.word_multiplier > wordMultiplier) {
        wordMultiplier = letterAndWordMultiplier.word_multiplier;
      }

      // add tile point value, multiplied by letter multiplier
      const tilePointValue = await CanonicalTiles.getTilePointValue(
        tilePlayed.canonicalTileID
      );
      totalScore += tilePointValue * letterAndWordMultiplier.letter_multiplier;
    }

    // multiply total score by word multiplier
    totalScore *= wordMultiplier;

    // bingo reward
    if (tilesPlayed.length == 7) {
      totalScore += 50;
    }

    // update user score
    await GameUsers.updateUserScoreInGame(game_id, user_id, totalScore);

    // emit the player's id and their new score to the room
    const newPlayerScore = await GameUsers.getUserScoreInGame(game_id, user_id);
    io.sockets.in(game_id).emit("player-score-updated", newPlayerScore);

    // get and set new current player & emit to room
    await giveTurnToNextPlayer(game_id, io);

    // emit the added tiles to the room
    io.sockets.in(game_id).emit("board-updated", tilesPlayed);

    // give new tiles to the player
    const newTilesForUser = await giveTilesFromBagToUser(
      user_id,
      game_id,
      tilesPlayed.length
    );

    await Games.setGamePassCount(0, game_id);

    response.status(200).send(newTilesForUser);
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

router.post("/:id/swap", async (request, response) => {
  const { id: game_id } = request.params;
  const { id: user_id } = request.session.user;
  const io = request.app.get("io");

  const tilesSent = request.body;

  try {
    // ensure player is in game
    const userInGame = await ensureUserInGame(user_id, game_id);
    if (!userInGame) {
      throw new Error("User not in game!");
    }

    // ensure it is player's turn
    const userCanMakeTurn = await ensureUserCanMakeTurn(user_id, game_id);
    if (!userCanMakeTurn) {
      throw new Error("User can't make turn!");
    }

    // check if enough tiles in bag
    const numTilesinBag = await GameTiles.getNumberOfTilesInBag(game_id);
    if (numTilesinBag < 7) {
      throw new Error("Bag does not have enough tiles!");
    }

    // parse request object and get tiles they want to swap
    // ensure player has tiles
    const userHasTiles = await ensureUserHasTiles(
      user_id,
      game_id,
      tilesSent,
      "canonicalTileID"
    );

    if (!userHasTiles) {
      throw new Error("User doesn't have the tiles!");
    }

    // give user new tiles
    const newTiles = await giveTilesFromBagToUser(
      user_id,
      game_id,
      tilesSent.length
    );

    // set the user's old tiles' user_id to -1 in game_tiles
    for (const tile of tilesSent) {
      await GameTiles.updateGameTiles(
        game_id,
        -1,
        tile.canonicalTileID,
        -1,
        -1
      );
    }

    // give turn to next player
    await giveTurnToNextPlayer(game_id, io);

    // set pass count to 0
    await Games.setGamePassCount(0, game_id);

    // return new tiles to frontend
    response.status(200).json(newTiles);
  } catch (error) {
    console.log(error);
    response.status(500).json({ message: error.message });
  }
});

router.post("/:id/resign", async (request, response) => {
  const { id: game_id } = request.params;
  const { id: user_id } = request.session.user;
  const io = request.app.get("io");

  try {
    // ensure player is in the game
    const userInGame = await ensureUserInGame(user_id, game_id);
    if (!userInGame) {
      throw new Error("User not in game!");
    }

    // check if the player can make a turn
    const userCanMakeTurn = await ensureUserCanMakeTurn(user_id, game_id);
    if (!userCanMakeTurn) {
      throw new Error("User can't make turn!");
    }

    // set their score to -1, emit to room
    await GameUsers.setUserScore(-1, game_id, user_id);
    io.sockets
      .in(game_id)
      .emit("player-score-updated", { user_id: user_id, score: -1 });

    // set the player resigned column to true
    await GameUsers.setResigned(true, game_id, user_id);

    // give their tiles back to the bag
    await GameTiles.giveTilesFromUserToBag(game_id, user_id);

    // get number of players originally in the game
    const numberOfPlayers = (await Games.gameInformation(game_id)).player_count;

    // get number of players that resigned
    const numberOfResignedPlayers = (
      await GameUsers.getResignedPlayers(game_id)
    ).length;

    // game is over if only 1 non-resigned player in the game
    if (numberOfPlayers - numberOfResignedPlayers == 1) {
      // only 1 player, game over

      // set in games table that game is over
      await Games.setGameEnded(game_id);

      // emit to everyone in room that game is over
      io.sockets.in(game_id).emit("game-ended");
    } else {
      // at least 2 non-resigned players; give turn to next player

      await giveTurnToNextPlayer(game_id, io);
    }

    await Games.setGamePassCount(0, game_id);

    response.status(200).send("Success");
  } catch (error) {
    console.log(error);
    response.status(500).json({ message: error.message });
  }
});

router.post("/:id/pass-turn", async (request, response) => {
  const { id: game_id } = request.params;
  const { id: user_id } = request.session.user;
  const io = request.app.get("io");

  try {
    // ensure player is in the game
    const userInGame = await ensureUserInGame(user_id, game_id);
    if (!userInGame) {
      throw new Error("User not in game!");
    }

    // check if the player can make a turn
    const userCanMakeTurn = await ensureUserCanMakeTurn(user_id, game_id);
    if (!userCanMakeTurn) {
      throw new Error("User can't make turn!");
    }

    // get number of non-resigned players in the game
    const numberOfNonResignedPlayers = (
      await GameUsers.getNonResignedPlayers(game_id)
    ).length;

    // get current number of passes in the game
    const currentNumberOfPasses = (await Games.gameInformation(game_id))
      .pass_count;

    // check for end of game
    if (numberOfNonResignedPlayers * 2 - 1 == currentNumberOfPasses) {
      // game is over

      // set in games table that game is over
      await Games.setGameEnded(game_id);

      // emit to everyone in room that game is over
      io.sockets.in(game_id).emit("game-ended");
    } else {
      // increment pass count and turn control to next player
      await Games.setGamePassCount(currentNumberOfPasses + 1, game_id);
      await giveTurnToNextPlayer(game_id, io);
    }

    response.status(200).send("Success");
  } catch (error) {
    response.status(500).json({ message: error.message });
  }
});

module.exports = router;
