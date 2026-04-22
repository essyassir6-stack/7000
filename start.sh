#!/bin/bash

# Install FFmpeg if not present
if ! command -v ffmpeg &> /dev/null; then
    echo "Installing FFmpeg..."
    apt-get update
    apt-get install -y ffmpeg
fi

# Start the bot
node index.js
