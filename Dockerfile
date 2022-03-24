FROM node:17-slim
WORKDIR /fetcher
RUN apt-get update -y && apt-get upgrade -y && \
    apt-get install -y pdftk texlive-extra-utils poppler-utils
RUN npm install -g nodemon
ADD . /fetcher
RUN npm install
CMD node main.js