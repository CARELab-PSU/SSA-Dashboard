"""
How Claire can drive the SSA dashboard.

Two routes are shown. Pick one.

A. Claire opens the dashboard in her own window (pywebview) and calls the
   page's commands directly. Nothing else to run.  pip install pywebview

B. Claire runs a small WebSocket server and the dashboard, opened in any
   browser with ?claire=ws://localhost:8765, connects to it.
   pip install websockets

Either way the language model gets the command list from SSA.tools() and
Claire passes each tool call to SSA.run(name, options).
"""
import json

DASHBOARD = "https://carelab-psu.github.io/SSA-Dashboard/"


# ── Route A: pywebview window ─────────────────────────────────────────────
def route_a():
    import webview  # pywebview

    def js(code):
        # recent pywebview versions resolve a returned Promise; check yours with a quick test
        return window.evaluate_js(code)

    def run(name, options=None):
        return js(f"SSA.run({json.dumps(name)}, {json.dumps(options or {})})")

    def on_loaded():
        js("SSA.run('app.ready')")
        tools = js("SSA.tools()")              # hand these to the language model
        print(len(tools), "dashboard tools")
        print(run("lists.show", {"tab": "inview", "type": "debris"}))
        print(run("eph.visibility", {"target": "Maruthiakella"}))

    window = webview.create_window("SSA Dashboard", DASHBOARD, width=1600, height=990,
                                   background_color="#000000")
    webview.start(on_loaded)


# ── Route B: WebSocket server; open DASHBOARD + "?claire=ws://localhost:8765" ──
def route_b():
    import asyncio, itertools
    import websockets

    async def handler(ws):
        hello = json.loads(await ws.recv())    # {"type": "hello", "app": ..., "version": ...}
        print("connected:", hello)
        ids = itertools.count(1)
        pending = {}

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m.get("type") == "event":
                    continue                   # ready / command / change events
                fut = pending.pop(m.get("id"), None)
                if fut:
                    fut.set_result(m)

        async def call(command=None, args=None, kind=None):
            i = next(ids)
            fut = asyncio.get_running_loop().create_future()
            pending[i] = fut
            msg = {"id": i, "type": kind} if kind else {"id": i, "command": command, "args": args or {}}
            await ws.send(json.dumps(msg))
            return await fut

        task = asyncio.create_task(reader())
        desc = await call(kind="describe")     # desc["tools"] → language model
        print(len(desc["tools"]), "dashboard tools")
        print(await call("lists.get", {"tab": "passes", "visible_only": True, "limit": 5}))
        task.cancel()

    async def main():
        async with websockets.serve(handler, "localhost", 8765):
            await asyncio.Future()

    asyncio.run(main())


if __name__ == "__main__":
    route_a()
