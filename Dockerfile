# Start with a base image that already has Node.js and includes essential Linux tools
FROM node:22-slim

# Install system dependencies (ffmpeg and Python/pip for yt-dlp)
# We combine the apt commands to be more efficient
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends ffmpeg python3-pip && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install yt-dlp using pip
RUN pip3 install yt-dlp

# Set the working directory for your application code
WORKDIR /usr/src/app

# Copy the server directory content to the container
# NOTE: Your Node.js code is in the 'server' sub-folder
COPY server/ .

# Install Node.js dependencies
RUN npm install

# Expose the port your application listens on (Render uses this)
EXPOSE 4000

# Define the command to run your app
CMD [ "node", "server.js" ]