"""Run Today from source.

    python run.py            the app window
    python run.py --demo     with made-up calendar, weather, email and budget data
    python run.py --browser  no window: serve at http://localhost:8001
"""
import argparse
import os


def main() -> None:
    p = argparse.ArgumentParser(description="Run Today from source")
    p.add_argument("--demo", action="store_true", help="made-up data instead of yours")
    p.add_argument("--browser", action="store_true", help="no window; open http://localhost:8001 yourself")
    p.add_argument("--debug", action="store_true", help="enable the web inspector")
    args = p.parse_args()
    if args.demo:
        os.environ["TODAY_DEMO"] = "1"
    if args.browser:
        import uvicorn
        print("Open http://localhost:8001 (Ctrl+C to stop)", flush=True)
        uvicorn.run("app.main:app", host="127.0.0.1", port=8001, log_level="warning")
        return
    from app.desktop import main as desktop_main
    desktop_main(debug=args.debug)


if __name__ == "__main__":
    main()
