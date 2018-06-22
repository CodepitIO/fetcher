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

exports.S3 = new aws.S3({params: {Bucket: C.CONN.GET_S3_BUCKET()}});
