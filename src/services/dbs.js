'use strict';

const mongoose  = require('mongoose'),
      aws       = require('aws-sdk');

const C = require('../../common/constants');

mongoose.Promise = require('bluebird');
mongoose.connect(C.CONN.MONGO.GET_URL(), {
  reconnectTries: 5,
  reconnectInterval: 5000,
}, (err) => {
  if (err) {
    console.log(err);
    process.exit(1);
  }
});

// TODO: move keys to constants or ENV
aws.config.update({
  accessKeyId: "AKIAZCJDHH3XDR64J7IQ",
  secretAccessKey: "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"
});
exports.S3 = new aws.S3({params: {Bucket: C.CONN.GET_S3_BUCKET()}});
