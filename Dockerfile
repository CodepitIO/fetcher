FROM node:17-alpine
WORKDIR /fetcher
RUN apk add --no-cache qpdf texlive poppler-utils
RUN npm install -g nodemon
ADD . /fetcher
RUN npm install
CMD node main.js