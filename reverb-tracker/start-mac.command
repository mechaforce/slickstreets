#!/bin/bash
# Double-click to start the Reverb Price Tracker on a Mac.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is not installed. Get it from https://www.python.org/downloads/ and try again."
  read -r -p "Press Enter to close."
  exit 1
fi
python3 app.py
read -r -p "The tracker has stopped. Press Enter to close."
