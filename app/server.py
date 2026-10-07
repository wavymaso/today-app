"""Run the web app in a background thread for the desktop window."""
import socket
import threading
import time

import uvicorn


class BackgroundServer:
    def __init__(self, host: str = "127.0.0.1", port: int = 0):
        # Bind first so we know the port (0 = macOS picks a free one).
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((host, port))
        self.port = self.sock.getsockname()[1]
        from .main import app
        self.server = uvicorn.Server(uvicorn.Config(app, log_config=None, log_level="warning",
                                                    loop="asyncio", http="h11", ws="none", lifespan="on"))
        self.thread = threading.Thread(target=self.server.run, kwargs={"sockets": [self.sock]}, name="today-server", daemon=True)

    def start(self, timeout: float = 20) -> None:
        self.thread.start()
        deadline = time.monotonic() + timeout
        while not self.server.started:
            if not self.thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("The Today server didn't start; see the log for details.")
            time.sleep(0.02)

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=5)
        self.sock.close()
