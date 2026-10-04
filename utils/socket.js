let _io;

export function initSocket(io) {
  _io = io;
  _io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
}

export function getIO() {
  if (!_io) {
    throw new Error('Socket.io not initialized!');
  }
  return _io;
}

export function emitToAll(event, payload) {
  if (_io) {
    _io.emit(event, payload);
  }
}
