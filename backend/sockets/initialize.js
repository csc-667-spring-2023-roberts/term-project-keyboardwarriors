const http = require("http");
const { Server } = require("socket.io");

const GameUsers = require("../db/game_users.js");

const initSockets = (app, sessionMiddleware) => {
  const server = http.createServer(app);
  const io = new Server(server);

  io.engine.use(sessionMiddleware);

  io.on("connection", async (socket) => {
    console.log("Connection", socket.id);

    const gameID = socket.handshake.query.roomID;
    socket.join(gameID);

    // if not the lobby room
    if (gameID != 0) {
      const currentPlayer = await GameUsers.getCurrentPlayerOfGame(gameID);

      // send the current player to everyone in the game room
      io.sockets.in(gameID).emit("current-player", currentPlayer.user_id);
    }
  });

  app.set("io", io);

  return server;
};

module.exports = initSockets;
