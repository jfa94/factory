#!/usr/bin/env node
import { createRequire as __factoryCreateRequire } from 'node:module';
const require = __factoryCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS({
  "node_modules/graceful-fs/polyfills.js"(exports, module) {
    var constants = __require("constants");
    var origCwd = process.cwd;
    var cwd = null;
    var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
    process.cwd = function() {
      if (!cwd)
        cwd = origCwd.call(process);
      return cwd;
    };
    try {
      process.cwd();
    } catch (er) {
    }
    if (typeof process.chdir === "function") {
      chdir = process.chdir;
      process.chdir = function(d) {
        cwd = null;
        chdir.call(process, d);
      };
      if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir);
    }
    var chdir;
    module.exports = patch;
    function patch(fs) {
      if (constants.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
        patchLchmod(fs);
      }
      if (!fs.lutimes) {
        patchLutimes(fs);
      }
      fs.chown = chownFix(fs.chown);
      fs.fchown = chownFix(fs.fchown);
      fs.lchown = chownFix(fs.lchown);
      fs.chmod = chmodFix(fs.chmod);
      fs.fchmod = chmodFix(fs.fchmod);
      fs.lchmod = chmodFix(fs.lchmod);
      fs.chownSync = chownFixSync(fs.chownSync);
      fs.fchownSync = chownFixSync(fs.fchownSync);
      fs.lchownSync = chownFixSync(fs.lchownSync);
      fs.chmodSync = chmodFixSync(fs.chmodSync);
      fs.fchmodSync = chmodFixSync(fs.fchmodSync);
      fs.lchmodSync = chmodFixSync(fs.lchmodSync);
      fs.stat = statFix(fs.stat);
      fs.fstat = statFix(fs.fstat);
      fs.lstat = statFix(fs.lstat);
      fs.statSync = statFixSync(fs.statSync);
      fs.fstatSync = statFixSync(fs.fstatSync);
      fs.lstatSync = statFixSync(fs.lstatSync);
      if (fs.chmod && !fs.lchmod) {
        fs.lchmod = function(path3, mode, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchmodSync = function() {
        };
      }
      if (fs.chown && !fs.lchown) {
        fs.lchown = function(path3, uid, gid, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchownSync = function() {
        };
      }
      if (platform === "win32") {
        fs.rename = typeof fs.rename !== "function" ? fs.rename : (function(fs$rename) {
          function rename3(from, to, cb) {
            var start = Date.now();
            var backoff = 0;
            fs$rename(from, to, function CB(er) {
              if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 6e4) {
                setTimeout(function() {
                  fs.stat(to, function(stater, st) {
                    if (stater && stater.code === "ENOENT")
                      fs$rename(from, to, CB);
                    else
                      cb(er);
                  });
                }, backoff);
                if (backoff < 100)
                  backoff += 10;
                return;
              }
              if (cb) cb(er);
            });
          }
          if (Object.setPrototypeOf) Object.setPrototypeOf(rename3, fs$rename);
          return rename3;
        })(fs.rename);
      }
      fs.read = typeof fs.read !== "function" ? fs.read : (function(fs$read) {
        function read(fd, buffer, offset, length, position, callback_) {
          var callback;
          if (callback_ && typeof callback_ === "function") {
            var eagCounter = 0;
            callback = function(er, _, __) {
              if (er && er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                return fs$read.call(fs, fd, buffer, offset, length, position, callback);
              }
              callback_.apply(this, arguments);
            };
          }
          return fs$read.call(fs, fd, buffer, offset, length, position, callback);
        }
        if (Object.setPrototypeOf) Object.setPrototypeOf(read, fs$read);
        return read;
      })(fs.read);
      fs.readSync = typeof fs.readSync !== "function" ? fs.readSync : /* @__PURE__ */ (function(fs$readSync) {
        return function(fd, buffer, offset, length, position) {
          var eagCounter = 0;
          while (true) {
            try {
              return fs$readSync.call(fs, fd, buffer, offset, length, position);
            } catch (er) {
              if (er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                continue;
              }
              throw er;
            }
          }
        };
      })(fs.readSync);
      function patchLchmod(fs2) {
        fs2.lchmod = function(path3, mode, callback) {
          fs2.open(
            path3,
            constants.O_WRONLY | constants.O_SYMLINK,
            mode,
            function(err, fd) {
              if (err) {
                if (callback) callback(err);
                return;
              }
              fs2.fchmod(fd, mode, function(err2) {
                fs2.close(fd, function(err22) {
                  if (callback) callback(err2 || err22);
                });
              });
            }
          );
        };
        fs2.lchmodSync = function(path3, mode) {
          var fd = fs2.openSync(path3, constants.O_WRONLY | constants.O_SYMLINK, mode);
          var threw = true;
          var ret;
          try {
            ret = fs2.fchmodSync(fd, mode);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs2.closeSync(fd);
              } catch (er) {
              }
            } else {
              fs2.closeSync(fd);
            }
          }
          return ret;
        };
      }
      function patchLutimes(fs2) {
        if (constants.hasOwnProperty("O_SYMLINK") && fs2.futimes) {
          fs2.lutimes = function(path3, at2, mt, cb) {
            fs2.open(path3, constants.O_SYMLINK, function(er, fd) {
              if (er) {
                if (cb) cb(er);
                return;
              }
              fs2.futimes(fd, at2, mt, function(er2) {
                fs2.close(fd, function(er22) {
                  if (cb) cb(er2 || er22);
                });
              });
            });
          };
          fs2.lutimesSync = function(path3, at2, mt) {
            var fd = fs2.openSync(path3, constants.O_SYMLINK);
            var ret;
            var threw = true;
            try {
              ret = fs2.futimesSync(fd, at2, mt);
              threw = false;
            } finally {
              if (threw) {
                try {
                  fs2.closeSync(fd);
                } catch (er) {
                }
              } else {
                fs2.closeSync(fd);
              }
            }
            return ret;
          };
        } else if (fs2.futimes) {
          fs2.lutimes = function(_a, _b, _c, cb) {
            if (cb) process.nextTick(cb);
          };
          fs2.lutimesSync = function() {
          };
        }
      }
      function chmodFix(orig) {
        if (!orig) return orig;
        return function(target, mode, cb) {
          return orig.call(fs, target, mode, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chmodFixSync(orig) {
        if (!orig) return orig;
        return function(target, mode) {
          try {
            return orig.call(fs, target, mode);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function chownFix(orig) {
        if (!orig) return orig;
        return function(target, uid, gid, cb) {
          return orig.call(fs, target, uid, gid, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chownFixSync(orig) {
        if (!orig) return orig;
        return function(target, uid, gid) {
          try {
            return orig.call(fs, target, uid, gid);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function statFix(orig) {
        if (!orig) return orig;
        return function(target, options, cb) {
          if (typeof options === "function") {
            cb = options;
            options = null;
          }
          function callback(er, stats) {
            if (stats) {
              if (stats.uid < 0) stats.uid += 4294967296;
              if (stats.gid < 0) stats.gid += 4294967296;
            }
            if (cb) cb.apply(this, arguments);
          }
          return options ? orig.call(fs, target, options, callback) : orig.call(fs, target, callback);
        };
      }
      function statFixSync(orig) {
        if (!orig) return orig;
        return function(target, options) {
          var stats = options ? orig.call(fs, target, options) : orig.call(fs, target);
          if (stats) {
            if (stats.uid < 0) stats.uid += 4294967296;
            if (stats.gid < 0) stats.gid += 4294967296;
          }
          return stats;
        };
      }
      function chownErOk(er) {
        if (!er)
          return true;
        if (er.code === "ENOSYS")
          return true;
        var nonroot = !process.getuid || process.getuid() !== 0;
        if (nonroot) {
          if (er.code === "EINVAL" || er.code === "EPERM")
            return true;
        }
        return false;
      }
    }
  }
});

// node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS({
  "node_modules/graceful-fs/legacy-streams.js"(exports, module) {
    var Stream = __require("stream").Stream;
    module.exports = legacy;
    function legacy(fs) {
      return {
        ReadStream,
        WriteStream
      };
      function ReadStream(path3, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(path3, options);
        Stream.call(this);
        var self = this;
        this.path = path3;
        this.fd = null;
        this.readable = true;
        this.paused = false;
        this.flags = "r";
        this.mode = 438;
        this.bufferSize = 64 * 1024;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.encoding) this.setEncoding(this.encoding);
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.end === void 0) {
            this.end = Infinity;
          } else if ("number" !== typeof this.end) {
            throw TypeError("end must be a Number");
          }
          if (this.start > this.end) {
            throw new Error("start must be <= end");
          }
          this.pos = this.start;
        }
        if (this.fd !== null) {
          process.nextTick(function() {
            self._read();
          });
          return;
        }
        fs.open(this.path, this.flags, this.mode, function(err, fd) {
          if (err) {
            self.emit("error", err);
            self.readable = false;
            return;
          }
          self.fd = fd;
          self.emit("open", fd);
          self._read();
        });
      }
      function WriteStream(path3, options) {
        if (!(this instanceof WriteStream)) return new WriteStream(path3, options);
        Stream.call(this);
        this.path = path3;
        this.fd = null;
        this.writable = true;
        this.flags = "w";
        this.encoding = "binary";
        this.mode = 438;
        this.bytesWritten = 0;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.start < 0) {
            throw new Error("start must be >= zero");
          }
          this.pos = this.start;
        }
        this.busy = false;
        this._queue = [];
        if (this.fd === null) {
          this._open = fs.open;
          this._queue.push([this._open, this.path, this.flags, this.mode, void 0]);
          this.flush();
        }
      }
    }
  }
});

// node_modules/graceful-fs/clone.js
var require_clone = __commonJS({
  "node_modules/graceful-fs/clone.js"(exports, module) {
    "use strict";
    module.exports = clone;
    var getPrototypeOf = Object.getPrototypeOf || function(obj) {
      return obj.__proto__;
    };
    function clone(obj) {
      if (obj === null || typeof obj !== "object")
        return obj;
      if (obj instanceof Object)
        var copy = { __proto__: getPrototypeOf(obj) };
      else
        var copy = /* @__PURE__ */ Object.create(null);
      Object.getOwnPropertyNames(obj).forEach(function(key) {
        Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
      });
      return copy;
    }
  }
});

// node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS({
  "node_modules/graceful-fs/graceful-fs.js"(exports, module) {
    var fs = __require("fs");
    var polyfills = require_polyfills();
    var legacy = require_legacy_streams();
    var clone = require_clone();
    var util2 = __require("util");
    var gracefulQueue;
    var previousSymbol;
    if (typeof Symbol === "function" && typeof Symbol.for === "function") {
      gracefulQueue = Symbol.for("graceful-fs.queue");
      previousSymbol = Symbol.for("graceful-fs.previous");
    } else {
      gracefulQueue = "___graceful-fs.queue";
      previousSymbol = "___graceful-fs.previous";
    }
    function noop() {
    }
    function publishQueue(context, queue2) {
      Object.defineProperty(context, gracefulQueue, {
        get: function() {
          return queue2;
        }
      });
    }
    var debug = noop;
    if (util2.debuglog)
      debug = util2.debuglog("gfs4");
    else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
      debug = function() {
        var m = util2.format.apply(util2, arguments);
        m = "GFS4: " + m.split(/\n/).join("\nGFS4: ");
        console.error(m);
      };
    if (!fs[gracefulQueue]) {
      queue = global[gracefulQueue] || [];
      publishQueue(fs, queue);
      fs.close = (function(fs$close) {
        function close(fd, cb) {
          return fs$close.call(fs, fd, function(err) {
            if (!err) {
              resetQueue();
            }
            if (typeof cb === "function")
              cb.apply(this, arguments);
          });
        }
        Object.defineProperty(close, previousSymbol, {
          value: fs$close
        });
        return close;
      })(fs.close);
      fs.closeSync = (function(fs$closeSync) {
        function closeSync(fd) {
          fs$closeSync.apply(fs, arguments);
          resetQueue();
        }
        Object.defineProperty(closeSync, previousSymbol, {
          value: fs$closeSync
        });
        return closeSync;
      })(fs.closeSync);
      if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
        process.on("exit", function() {
          debug(fs[gracefulQueue]);
          __require("assert").equal(fs[gracefulQueue].length, 0);
        });
      }
    }
    var queue;
    if (!global[gracefulQueue]) {
      publishQueue(global, fs[gracefulQueue]);
    }
    module.exports = patch(clone(fs));
    if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
      module.exports = patch(fs);
      fs.__patched = true;
    }
    function patch(fs2) {
      polyfills(fs2);
      fs2.gracefulify = patch;
      fs2.createReadStream = createReadStream;
      fs2.createWriteStream = createWriteStream;
      var fs$readFile = fs2.readFile;
      fs2.readFile = readFile16;
      function readFile16(path3, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$readFile(path3, options, cb);
        function go$readFile(path4, options2, cb2, startTime) {
          return fs$readFile(path4, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$readFile, [path4, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$writeFile = fs2.writeFile;
      fs2.writeFile = writeFile4;
      function writeFile4(path3, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$writeFile(path3, data, options, cb);
        function go$writeFile(path4, data2, options2, cb2, startTime) {
          return fs$writeFile(path4, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$writeFile, [path4, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$appendFile = fs2.appendFile;
      if (fs$appendFile)
        fs2.appendFile = appendFile;
      function appendFile(path3, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$appendFile(path3, data, options, cb);
        function go$appendFile(path4, data2, options2, cb2, startTime) {
          return fs$appendFile(path4, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$appendFile, [path4, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$copyFile = fs2.copyFile;
      if (fs$copyFile)
        fs2.copyFile = copyFile;
      function copyFile(src, dest, flags, cb) {
        if (typeof flags === "function") {
          cb = flags;
          flags = 0;
        }
        return go$copyFile(src, dest, flags, cb);
        function go$copyFile(src2, dest2, flags2, cb2, startTime) {
          return fs$copyFile(src2, dest2, flags2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$copyFile, [src2, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$readdir = fs2.readdir;
      fs2.readdir = readdir4;
      var noReaddirOptionVersions = /^v[0-5]\./;
      function readdir4(path3, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path4, options2, cb2, startTime) {
          return fs$readdir(path4, fs$readdirCallback(
            path4,
            options2,
            cb2,
            startTime
          ));
        } : function go$readdir2(path4, options2, cb2, startTime) {
          return fs$readdir(path4, options2, fs$readdirCallback(
            path4,
            options2,
            cb2,
            startTime
          ));
        };
        return go$readdir(path3, options, cb);
        function fs$readdirCallback(path4, options2, cb2, startTime) {
          return function(err, files) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([
                go$readdir,
                [path4, options2, cb2],
                err,
                startTime || Date.now(),
                Date.now()
              ]);
            else {
              if (files && files.sort)
                files.sort();
              if (typeof cb2 === "function")
                cb2.call(this, err, files);
            }
          };
        }
      }
      if (process.version.substr(0, 4) === "v0.8") {
        var legStreams = legacy(fs2);
        ReadStream = legStreams.ReadStream;
        WriteStream = legStreams.WriteStream;
      }
      var fs$ReadStream = fs2.ReadStream;
      if (fs$ReadStream) {
        ReadStream.prototype = Object.create(fs$ReadStream.prototype);
        ReadStream.prototype.open = ReadStream$open;
      }
      var fs$WriteStream = fs2.WriteStream;
      if (fs$WriteStream) {
        WriteStream.prototype = Object.create(fs$WriteStream.prototype);
        WriteStream.prototype.open = WriteStream$open;
      }
      Object.defineProperty(fs2, "ReadStream", {
        get: function() {
          return ReadStream;
        },
        set: function(val) {
          ReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(fs2, "WriteStream", {
        get: function() {
          return WriteStream;
        },
        set: function(val) {
          WriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileReadStream = ReadStream;
      Object.defineProperty(fs2, "FileReadStream", {
        get: function() {
          return FileReadStream;
        },
        set: function(val) {
          FileReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileWriteStream = WriteStream;
      Object.defineProperty(fs2, "FileWriteStream", {
        get: function() {
          return FileWriteStream;
        },
        set: function(val) {
          FileWriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      function ReadStream(path3, options) {
        if (this instanceof ReadStream)
          return fs$ReadStream.apply(this, arguments), this;
        else
          return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
      }
      function ReadStream$open() {
        var that = this;
        open2(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            if (that.autoClose)
              that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
            that.read();
          }
        });
      }
      function WriteStream(path3, options) {
        if (this instanceof WriteStream)
          return fs$WriteStream.apply(this, arguments), this;
        else
          return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
      }
      function WriteStream$open() {
        var that = this;
        open2(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
          }
        });
      }
      function createReadStream(path3, options) {
        return new fs2.ReadStream(path3, options);
      }
      function createWriteStream(path3, options) {
        return new fs2.WriteStream(path3, options);
      }
      var fs$open = fs2.open;
      fs2.open = open2;
      function open2(path3, flags, mode, cb) {
        if (typeof mode === "function")
          cb = mode, mode = null;
        return go$open(path3, flags, mode, cb);
        function go$open(path4, flags2, mode2, cb2, startTime) {
          return fs$open(path4, flags2, mode2, function(err, fd) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$open, [path4, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      return fs2;
    }
    function enqueue(elem) {
      debug("ENQUEUE", elem[0].name, elem[1]);
      fs[gracefulQueue].push(elem);
      retry();
    }
    var retryTimer;
    function resetQueue() {
      var now = Date.now();
      for (var i = 0; i < fs[gracefulQueue].length; ++i) {
        if (fs[gracefulQueue][i].length > 2) {
          fs[gracefulQueue][i][3] = now;
          fs[gracefulQueue][i][4] = now;
        }
      }
      retry();
    }
    function retry() {
      clearTimeout(retryTimer);
      retryTimer = void 0;
      if (fs[gracefulQueue].length === 0)
        return;
      var elem = fs[gracefulQueue].shift();
      var fn = elem[0];
      var args = elem[1];
      var err = elem[2];
      var startTime = elem[3];
      var lastTime = elem[4];
      if (startTime === void 0) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args);
      } else if (Date.now() - startTime >= 6e4) {
        debug("TIMEOUT", fn.name, args);
        var cb = args.pop();
        if (typeof cb === "function")
          cb.call(null, err);
      } else {
        var sinceAttempt = Date.now() - lastTime;
        var sinceStart = Math.max(lastTime - startTime, 1);
        var desiredDelay = Math.min(sinceStart * 1.2, 100);
        if (sinceAttempt >= desiredDelay) {
          debug("RETRY", fn.name, args);
          fn.apply(null, args.concat([startTime]));
        } else {
          fs[gracefulQueue].push(elem);
        }
      }
      if (retryTimer === void 0) {
        retryTimer = setTimeout(retry, 0);
      }
    }
  }
});

// node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS({
  "node_modules/retry/lib/retry_operation.js"(exports, module) {
    function RetryOperation(timeouts, options) {
      if (typeof options === "boolean") {
        options = { forever: options };
      }
      this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
      this._timeouts = timeouts;
      this._options = options || {};
      this._maxRetryTime = options && options.maxRetryTime || Infinity;
      this._fn = null;
      this._errors = [];
      this._attempts = 1;
      this._operationTimeout = null;
      this._operationTimeoutCb = null;
      this._timeout = null;
      this._operationStart = null;
      if (this._options.forever) {
        this._cachedTimeouts = this._timeouts.slice(0);
      }
    }
    module.exports = RetryOperation;
    RetryOperation.prototype.reset = function() {
      this._attempts = 1;
      this._timeouts = this._originalTimeouts;
    };
    RetryOperation.prototype.stop = function() {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      this._timeouts = [];
      this._cachedTimeouts = null;
    };
    RetryOperation.prototype.retry = function(err) {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (!err) {
        return false;
      }
      var currentTime = (/* @__PURE__ */ new Date()).getTime();
      if (err && currentTime - this._operationStart >= this._maxRetryTime) {
        this._errors.unshift(new Error("RetryOperation timeout occurred"));
        return false;
      }
      this._errors.push(err);
      var timeout = this._timeouts.shift();
      if (timeout === void 0) {
        if (this._cachedTimeouts) {
          this._errors.splice(this._errors.length - 1, this._errors.length);
          this._timeouts = this._cachedTimeouts.slice(0);
          timeout = this._timeouts.shift();
        } else {
          return false;
        }
      }
      var self = this;
      var timer = setTimeout(function() {
        self._attempts++;
        if (self._operationTimeoutCb) {
          self._timeout = setTimeout(function() {
            self._operationTimeoutCb(self._attempts);
          }, self._operationTimeout);
          if (self._options.unref) {
            self._timeout.unref();
          }
        }
        self._fn(self._attempts);
      }, timeout);
      if (this._options.unref) {
        timer.unref();
      }
      return true;
    };
    RetryOperation.prototype.attempt = function(fn, timeoutOps) {
      this._fn = fn;
      if (timeoutOps) {
        if (timeoutOps.timeout) {
          this._operationTimeout = timeoutOps.timeout;
        }
        if (timeoutOps.cb) {
          this._operationTimeoutCb = timeoutOps.cb;
        }
      }
      var self = this;
      if (this._operationTimeoutCb) {
        this._timeout = setTimeout(function() {
          self._operationTimeoutCb();
        }, self._operationTimeout);
      }
      this._operationStart = (/* @__PURE__ */ new Date()).getTime();
      this._fn(this._attempts);
    };
    RetryOperation.prototype.try = function(fn) {
      console.log("Using RetryOperation.try() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = function(fn) {
      console.log("Using RetryOperation.start() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = RetryOperation.prototype.try;
    RetryOperation.prototype.errors = function() {
      return this._errors;
    };
    RetryOperation.prototype.attempts = function() {
      return this._attempts;
    };
    RetryOperation.prototype.mainError = function() {
      if (this._errors.length === 0) {
        return null;
      }
      var counts = {};
      var mainError = null;
      var mainErrorCount = 0;
      for (var i = 0; i < this._errors.length; i++) {
        var error = this._errors[i];
        var message = error.message;
        var count = (counts[message] || 0) + 1;
        counts[message] = count;
        if (count >= mainErrorCount) {
          mainError = error;
          mainErrorCount = count;
        }
      }
      return mainError;
    };
  }
});

// node_modules/retry/lib/retry.js
var require_retry = __commonJS({
  "node_modules/retry/lib/retry.js"(exports) {
    var RetryOperation = require_retry_operation();
    exports.operation = function(options) {
      var timeouts = exports.timeouts(options);
      return new RetryOperation(timeouts, {
        forever: options && options.forever,
        unref: options && options.unref,
        maxRetryTime: options && options.maxRetryTime
      });
    };
    exports.timeouts = function(options) {
      if (options instanceof Array) {
        return [].concat(options);
      }
      var opts = {
        retries: 10,
        factor: 2,
        minTimeout: 1 * 1e3,
        maxTimeout: Infinity,
        randomize: false
      };
      for (var key in options) {
        opts[key] = options[key];
      }
      if (opts.minTimeout > opts.maxTimeout) {
        throw new Error("minTimeout is greater than maxTimeout");
      }
      var timeouts = [];
      for (var i = 0; i < opts.retries; i++) {
        timeouts.push(this.createTimeout(i, opts));
      }
      if (options && options.forever && !timeouts.length) {
        timeouts.push(this.createTimeout(i, opts));
      }
      timeouts.sort(function(a, b) {
        return a - b;
      });
      return timeouts;
    };
    exports.createTimeout = function(attempt, opts) {
      var random = opts.randomize ? Math.random() + 1 : 1;
      var timeout = Math.round(random * opts.minTimeout * Math.pow(opts.factor, attempt));
      timeout = Math.min(timeout, opts.maxTimeout);
      return timeout;
    };
    exports.wrap = function(obj, options, methods) {
      if (options instanceof Array) {
        methods = options;
        options = null;
      }
      if (!methods) {
        methods = [];
        for (var key in obj) {
          if (typeof obj[key] === "function") {
            methods.push(key);
          }
        }
      }
      for (var i = 0; i < methods.length; i++) {
        var method = methods[i];
        var original = obj[method];
        obj[method] = function retryWrapper(original2) {
          var op = exports.operation(options);
          var args = Array.prototype.slice.call(arguments, 1);
          var callback = args.pop();
          args.push(function(err) {
            if (op.retry(err)) {
              return;
            }
            if (err) {
              arguments[0] = op.mainError();
            }
            callback.apply(this, arguments);
          });
          op.attempt(function() {
            original2.apply(obj, args);
          });
        }.bind(obj, original);
        obj[method].options = options;
      }
    };
  }
});

// node_modules/retry/index.js
var require_retry2 = __commonJS({
  "node_modules/retry/index.js"(exports, module) {
    module.exports = require_retry();
  }
});

// node_modules/signal-exit/signals.js
var require_signals = __commonJS({
  "node_modules/signal-exit/signals.js"(exports, module) {
    module.exports = [
      "SIGABRT",
      "SIGALRM",
      "SIGHUP",
      "SIGINT",
      "SIGTERM"
    ];
    if (process.platform !== "win32") {
      module.exports.push(
        "SIGVTALRM",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGUSR2",
        "SIGTRAP",
        "SIGSYS",
        "SIGQUIT",
        "SIGIOT"
        // should detect profiler and enable/disable accordingly.
        // see #21
        // 'SIGPROF'
      );
    }
    if (process.platform === "linux") {
      module.exports.push(
        "SIGIO",
        "SIGPOLL",
        "SIGPWR",
        "SIGSTKFLT",
        "SIGUNUSED"
      );
    }
  }
});

// node_modules/signal-exit/index.js
var require_signal_exit = __commonJS({
  "node_modules/signal-exit/index.js"(exports, module) {
    var process2 = global.process;
    var processOk = function(process3) {
      return process3 && typeof process3 === "object" && typeof process3.removeListener === "function" && typeof process3.emit === "function" && typeof process3.reallyExit === "function" && typeof process3.listeners === "function" && typeof process3.kill === "function" && typeof process3.pid === "number" && typeof process3.on === "function";
    };
    if (!processOk(process2)) {
      module.exports = function() {
        return function() {
        };
      };
    } else {
      assert = __require("assert");
      signals = require_signals();
      isWin = /^win/i.test(process2.platform);
      EE = __require("events");
      if (typeof EE !== "function") {
        EE = EE.EventEmitter;
      }
      if (process2.__signal_exit_emitter__) {
        emitter = process2.__signal_exit_emitter__;
      } else {
        emitter = process2.__signal_exit_emitter__ = new EE();
        emitter.count = 0;
        emitter.emitted = {};
      }
      if (!emitter.infinite) {
        emitter.setMaxListeners(Infinity);
        emitter.infinite = true;
      }
      module.exports = function(cb, opts) {
        if (!processOk(global.process)) {
          return function() {
          };
        }
        assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
        if (loaded === false) {
          load();
        }
        var ev = "exit";
        if (opts && opts.alwaysLast) {
          ev = "afterexit";
        }
        var remove = function() {
          emitter.removeListener(ev, cb);
          if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) {
            unload();
          }
        };
        emitter.on(ev, cb);
        return remove;
      };
      unload = function unload2() {
        if (!loaded || !processOk(global.process)) {
          return;
        }
        loaded = false;
        signals.forEach(function(sig) {
          try {
            process2.removeListener(sig, sigListeners[sig]);
          } catch (er) {
          }
        });
        process2.emit = originalProcessEmit;
        process2.reallyExit = originalProcessReallyExit;
        emitter.count -= 1;
      };
      module.exports.unload = unload;
      emit2 = function emit3(event, code, signal) {
        if (emitter.emitted[event]) {
          return;
        }
        emitter.emitted[event] = true;
        emitter.emit(event, code, signal);
      };
      sigListeners = {};
      signals.forEach(function(sig) {
        sigListeners[sig] = function listener() {
          if (!processOk(global.process)) {
            return;
          }
          var listeners = process2.listeners(sig);
          if (listeners.length === emitter.count) {
            unload();
            emit2("exit", null, sig);
            emit2("afterexit", null, sig);
            if (isWin && sig === "SIGHUP") {
              sig = "SIGINT";
            }
            process2.kill(process2.pid, sig);
          }
        };
      });
      module.exports.signals = function() {
        return signals;
      };
      loaded = false;
      load = function load2() {
        if (loaded || !processOk(global.process)) {
          return;
        }
        loaded = true;
        emitter.count += 1;
        signals = signals.filter(function(sig) {
          try {
            process2.on(sig, sigListeners[sig]);
            return true;
          } catch (er) {
            return false;
          }
        });
        process2.emit = processEmit;
        process2.reallyExit = processReallyExit;
      };
      module.exports.load = load;
      originalProcessReallyExit = process2.reallyExit;
      processReallyExit = function processReallyExit2(code) {
        if (!processOk(global.process)) {
          return;
        }
        process2.exitCode = code || /* istanbul ignore next */
        0;
        emit2("exit", process2.exitCode, null);
        emit2("afterexit", process2.exitCode, null);
        originalProcessReallyExit.call(process2, process2.exitCode);
      };
      originalProcessEmit = process2.emit;
      processEmit = function processEmit2(ev, arg) {
        if (ev === "exit" && processOk(global.process)) {
          if (arg !== void 0) {
            process2.exitCode = arg;
          }
          var ret = originalProcessEmit.apply(this, arguments);
          emit2("exit", process2.exitCode, null);
          emit2("afterexit", process2.exitCode, null);
          return ret;
        } else {
          return originalProcessEmit.apply(this, arguments);
        }
      };
    }
    var assert;
    var signals;
    var isWin;
    var EE;
    var emitter;
    var unload;
    var emit2;
    var sigListeners;
    var loaded;
    var load;
    var originalProcessReallyExit;
    var processReallyExit;
    var originalProcessEmit;
    var processEmit;
  }
});

// node_modules/proper-lockfile/lib/mtime-precision.js
var require_mtime_precision = __commonJS({
  "node_modules/proper-lockfile/lib/mtime-precision.js"(exports, module) {
    "use strict";
    var cacheSymbol = Symbol();
    function probe(file, fs, callback) {
      const cachedPrecision = fs[cacheSymbol];
      if (cachedPrecision) {
        return fs.stat(file, (err, stat) => {
          if (err) {
            return callback(err);
          }
          callback(null, stat.mtime, cachedPrecision);
        });
      }
      const mtime = new Date(Math.ceil(Date.now() / 1e3) * 1e3 + 5);
      fs.utimes(file, mtime, mtime, (err) => {
        if (err) {
          return callback(err);
        }
        fs.stat(file, (err2, stat) => {
          if (err2) {
            return callback(err2);
          }
          const precision = stat.mtime.getTime() % 1e3 === 0 ? "s" : "ms";
          Object.defineProperty(fs, cacheSymbol, { value: precision });
          callback(null, stat.mtime, precision);
        });
      });
    }
    function getMtime(precision) {
      let now = Date.now();
      if (precision === "s") {
        now = Math.ceil(now / 1e3) * 1e3;
      }
      return new Date(now);
    }
    module.exports.probe = probe;
    module.exports.getMtime = getMtime;
  }
});

// node_modules/proper-lockfile/lib/lockfile.js
var require_lockfile = __commonJS({
  "node_modules/proper-lockfile/lib/lockfile.js"(exports, module) {
    "use strict";
    var path3 = __require("path");
    var fs = require_graceful_fs();
    var retry = require_retry2();
    var onExit = require_signal_exit();
    var mtimePrecision = require_mtime_precision();
    var locks = {};
    function getLockFile(file, options) {
      return options.lockfilePath || `${file}.lock`;
    }
    function resolveCanonicalPath(file, options, callback) {
      if (!options.realpath) {
        return callback(null, path3.resolve(file));
      }
      options.fs.realpath(file, callback);
    }
    function acquireLock(file, options, callback) {
      const lockfilePath = getLockFile(file, options);
      options.fs.mkdir(lockfilePath, (err) => {
        if (!err) {
          return mtimePrecision.probe(lockfilePath, options.fs, (err2, mtime, mtimePrecision2) => {
            if (err2) {
              options.fs.rmdir(lockfilePath, () => {
              });
              return callback(err2);
            }
            callback(null, mtime, mtimePrecision2);
          });
        }
        if (err.code !== "EEXIST") {
          return callback(err);
        }
        if (options.stale <= 0) {
          return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
        }
        options.fs.stat(lockfilePath, (err2, stat) => {
          if (err2) {
            if (err2.code === "ENOENT") {
              return acquireLock(file, { ...options, stale: 0 }, callback);
            }
            return callback(err2);
          }
          if (!isLockStale(stat, options)) {
            return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
          }
          removeLock(file, options, (err3) => {
            if (err3) {
              return callback(err3);
            }
            acquireLock(file, { ...options, stale: 0 }, callback);
          });
        });
      });
    }
    function isLockStale(stat, options) {
      return stat.mtime.getTime() < Date.now() - options.stale;
    }
    function removeLock(file, options, callback) {
      options.fs.rmdir(getLockFile(file, options), (err) => {
        if (err && err.code !== "ENOENT") {
          return callback(err);
        }
        callback();
      });
    }
    function updateLock(file, options) {
      const lock3 = locks[file];
      if (lock3.updateTimeout) {
        return;
      }
      lock3.updateDelay = lock3.updateDelay || options.update;
      lock3.updateTimeout = setTimeout(() => {
        lock3.updateTimeout = null;
        options.fs.stat(lock3.lockfilePath, (err, stat) => {
          const isOverThreshold = lock3.lastUpdate + options.stale < Date.now();
          if (err) {
            if (err.code === "ENOENT" || isOverThreshold) {
              return setLockAsCompromised(file, lock3, Object.assign(err, { code: "ECOMPROMISED" }));
            }
            lock3.updateDelay = 1e3;
            return updateLock(file, options);
          }
          const isMtimeOurs = lock3.mtime.getTime() === stat.mtime.getTime();
          if (!isMtimeOurs) {
            return setLockAsCompromised(
              file,
              lock3,
              Object.assign(
                new Error("Unable to update lock within the stale threshold"),
                { code: "ECOMPROMISED" }
              )
            );
          }
          const mtime = mtimePrecision.getMtime(lock3.mtimePrecision);
          options.fs.utimes(lock3.lockfilePath, mtime, mtime, (err2) => {
            const isOverThreshold2 = lock3.lastUpdate + options.stale < Date.now();
            if (lock3.released) {
              return;
            }
            if (err2) {
              if (err2.code === "ENOENT" || isOverThreshold2) {
                return setLockAsCompromised(file, lock3, Object.assign(err2, { code: "ECOMPROMISED" }));
              }
              lock3.updateDelay = 1e3;
              return updateLock(file, options);
            }
            lock3.mtime = mtime;
            lock3.lastUpdate = Date.now();
            lock3.updateDelay = null;
            updateLock(file, options);
          });
        });
      }, lock3.updateDelay);
      if (lock3.updateTimeout.unref) {
        lock3.updateTimeout.unref();
      }
    }
    function setLockAsCompromised(file, lock3, err) {
      lock3.released = true;
      if (lock3.updateTimeout) {
        clearTimeout(lock3.updateTimeout);
      }
      if (locks[file] === lock3) {
        delete locks[file];
      }
      lock3.options.onCompromised(err);
    }
    function lock2(file, options, callback) {
      options = {
        stale: 1e4,
        update: null,
        realpath: true,
        retries: 0,
        fs,
        onCompromised: (err) => {
          throw err;
        },
        ...options
      };
      options.retries = options.retries || 0;
      options.retries = typeof options.retries === "number" ? { retries: options.retries } : options.retries;
      options.stale = Math.max(options.stale || 0, 2e3);
      options.update = options.update == null ? options.stale / 2 : options.update || 0;
      options.update = Math.max(Math.min(options.update, options.stale / 2), 1e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const operation = retry.operation(options.retries);
        operation.attempt(() => {
          acquireLock(file2, options, (err2, mtime, mtimePrecision2) => {
            if (operation.retry(err2)) {
              return;
            }
            if (err2) {
              return callback(operation.mainError());
            }
            const lock3 = locks[file2] = {
              lockfilePath: getLockFile(file2, options),
              mtime,
              mtimePrecision: mtimePrecision2,
              options,
              lastUpdate: Date.now()
            };
            updateLock(file2, options);
            callback(null, (releasedCallback) => {
              if (lock3.released) {
                return releasedCallback && releasedCallback(Object.assign(new Error("Lock is already released"), { code: "ERELEASED" }));
              }
              unlock(file2, { ...options, realpath: false }, releasedCallback);
            });
          });
        });
      });
    }
    function unlock(file, options, callback) {
      options = {
        fs,
        realpath: true,
        ...options
      };
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const lock3 = locks[file2];
        if (!lock3) {
          return callback(Object.assign(new Error("Lock is not acquired/owned by you"), { code: "ENOTACQUIRED" }));
        }
        lock3.updateTimeout && clearTimeout(lock3.updateTimeout);
        lock3.released = true;
        delete locks[file2];
        removeLock(file2, options, callback);
      });
    }
    function check(file, options, callback) {
      options = {
        stale: 1e4,
        realpath: true,
        fs,
        ...options
      };
      options.stale = Math.max(options.stale || 0, 2e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        options.fs.stat(getLockFile(file2, options), (err2, stat) => {
          if (err2) {
            return err2.code === "ENOENT" ? callback(null, false) : callback(err2);
          }
          return callback(null, !isLockStale(stat, options));
        });
      });
    }
    function getLocks() {
      return locks;
    }
    onExit(() => {
      for (const file in locks) {
        const options = locks[file].options;
        try {
          options.fs.rmdirSync(getLockFile(file, options));
        } catch (e) {
        }
      }
    });
    module.exports.lock = lock2;
    module.exports.unlock = unlock;
    module.exports.check = check;
    module.exports.getLocks = getLocks;
  }
});

// node_modules/proper-lockfile/lib/adapter.js
var require_adapter = __commonJS({
  "node_modules/proper-lockfile/lib/adapter.js"(exports, module) {
    "use strict";
    var fs = require_graceful_fs();
    function createSyncFs(fs2) {
      const methods = ["mkdir", "realpath", "stat", "rmdir", "utimes"];
      const newFs = { ...fs2 };
      methods.forEach((method) => {
        newFs[method] = (...args) => {
          const callback = args.pop();
          let ret;
          try {
            ret = fs2[`${method}Sync`](...args);
          } catch (err) {
            return callback(err);
          }
          callback(null, ret);
        };
      });
      return newFs;
    }
    function toPromise(method) {
      return (...args) => new Promise((resolve2, reject) => {
        args.push((err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve2(result);
          }
        });
        method(...args);
      });
    }
    function toSync(method) {
      return (...args) => {
        let err;
        let result;
        args.push((_err, _result) => {
          err = _err;
          result = _result;
        });
        method(...args);
        if (err) {
          throw err;
        }
        return result;
      };
    }
    function toSyncOptions(options) {
      options = { ...options };
      options.fs = createSyncFs(options.fs || fs);
      if (typeof options.retries === "number" && options.retries > 0 || options.retries && typeof options.retries.retries === "number" && options.retries.retries > 0) {
        throw Object.assign(new Error("Cannot use retries with the sync api"), { code: "ESYNC" });
      }
      return options;
    }
    module.exports = {
      toPromise,
      toSync,
      toSyncOptions
    };
  }
});

// node_modules/proper-lockfile/index.js
var require_proper_lockfile = __commonJS({
  "node_modules/proper-lockfile/index.js"(exports, module) {
    "use strict";
    var lockfile = require_lockfile();
    var { toPromise, toSync, toSyncOptions } = require_adapter();
    async function lock2(file, options) {
      const release = await toPromise(lockfile.lock)(file, options);
      return toPromise(release);
    }
    function lockSync(file, options) {
      const release = toSync(lockfile.lock)(file, toSyncOptions(options));
      return toSync(release);
    }
    function unlock(file, options) {
      return toPromise(lockfile.unlock)(file, options);
    }
    function unlockSync(file, options) {
      return toSync(lockfile.unlock)(file, toSyncOptions(options));
    }
    function check(file, options) {
      return toPromise(lockfile.check)(file, options);
    }
    function checkSync(file, options) {
      return toSync(lockfile.check)(file, toSyncOptions(options));
    }
    module.exports = lock2;
    module.exports.lock = lock2;
    module.exports.unlock = unlock;
    module.exports.lockSync = lockSync;
    module.exports.unlockSync = unlockSync;
    module.exports.check = check;
    module.exports.checkSync = checkSync;
  }
});

// src/shared/exit-codes.ts
var EXIT = {
  /** Success. */
  OK: 0,
  /** Generic failure (uncaught error, classified drop, gate/verify failure). */
  ERROR: 1,
  /** Usage error: unknown subcommand/hook, bad flags, missing required arg. */
  USAGE: 2,
  /** Conflict: an active run already exists and no resolution flag was passed. */
  CONFLICT: 3
};

// src/config/load.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { basename as basename2, dirname as dirname2, join as join2, resolve, sep } from "node:path";
import { homedir } from "node:os";

// src/shared/logging.ts
var LEVEL_RANK = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};
function activeThreshold() {
  const raw = (process.env.FACTORY_LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw && raw in LEVEL_RANK) {
    return LEVEL_RANK[raw];
  }
  if (process.env.FACTORY_QUIET === "1") {
    return LEVEL_RANK.error;
  }
  return LEVEL_RANK.info;
}
function emit(level, scope, args) {
  if (LEVEL_RANK[level] < activeThreshold()) {
    return;
  }
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const msg = args.map((a) => typeof a === "string" ? a : safeStringify(a)).join(" ");
  process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${scope}: ${msg}
`);
}
function safeStringify(value) {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function createLogger(scope) {
  return {
    debug: (...args) => {
      emit("debug", scope, args);
    },
    info: (...args) => {
      emit("info", scope, args);
    },
    warn: (...args) => {
      emit("warn", scope, args);
    },
    error: (...args) => {
      emit("error", scope, args);
    },
    child: (subScope) => createLogger(`${scope}:${subScope}`)
  };
}
var log = createLogger("factory");

// src/shared/json.ts
import { readFile } from "node:fs/promises";

// src/shared/atomic-write.ts
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";
function tempPathFor(target) {
  const dir = dirname(target);
  const name = basename(target);
  const rand = randomBytes(6).toString("hex");
  return join(dir, `.${name}.${process.pid}.${rand}.tmp`);
}
async function atomicWriteFile(target, data) {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = tempPathFor(target);
  const handle = await open(tmp, "w", 384);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close();
    await bestEffortUnlink(tmp);
    throw err;
  }
  await handle.close();
  try {
    await rename(tmp, target);
  } catch (err) {
    await bestEffortUnlink(tmp);
    throw err;
  }
  try {
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
  }
}
async function bestEffortUnlink(p) {
  try {
    await unlink(p);
  } catch {
  }
}

// src/shared/json.ts
var JsonParseError = class extends Error {
  path;
  cause;
  constructor(message, path3, cause) {
    super(message);
    this.name = "JsonParseError";
    this.path = path3;
    this.cause = cause;
  }
};
function parseJson(text, sourcePath) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    const where = sourcePath != null ? ` (from ${sourcePath})` : "";
    throw new JsonParseError(`invalid JSON${where}: ${cause.message}`, sourcePath, cause);
  }
}
async function readJsonFile(path3) {
  return parseJson(await readFile(path3, "utf8"), path3);
}
function stringifyJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever2(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever2;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal2 = i === issue.path.length - 1;
            if (!terminal2) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path: path3, errorMaps, issueData } = params;
  const fullPath = [...path3, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path3, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path3;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// src/shared/exec.ts
import { spawn } from "node:child_process";
var DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
function exec(command, args = [], opts = {}) {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve2, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.envMode === "replace" ? opts.env ?? {} : opts.env ? { ...process.env, ...opts.env } : process.env,
      shell: opts.shell ?? false,
      timeout: opts.timeoutMs,
      killSignal: opts.killSignal ?? "SIGTERM"
    });
    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let settled = false;
    const settleReject = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };
    child.stdout.on("data", (c) => {
      const remaining = maxBuffer - outLen;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (c.length > remaining) {
        outChunks.push(c.subarray(0, remaining));
        outLen = maxBuffer;
        truncated = true;
      } else {
        outChunks.push(c);
        outLen += c.length;
      }
    });
    child.stderr.on("data", (c) => {
      const remaining = maxBuffer - errLen;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (c.length > remaining) {
        errChunks.push(c.subarray(0, remaining));
        errLen = maxBuffer;
        truncated = true;
      } else {
        errChunks.push(c);
        errLen += c.length;
      }
    });
    child.on("error", settleReject);
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve2({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        code,
        signal: signal ?? null,
        truncated
      });
    });
    if (opts.input !== void 0) {
      child.stdin.on("error", (err) => {
        if (err.code === "EPIPE") {
          return;
        }
        settleReject(err);
      });
      child.stdin.end(opts.input);
    }
  });
}
var ExecError = class extends Error {
  result;
  command;
  args;
  constructor(command, args, result) {
    const where = [command, ...args].join(" ");
    super(
      `command failed (code=${result.code ?? "null"}` + (result.signal ? `, signal=${result.signal}` : "") + `): ${where}
${result.stderr.trim()}`
    );
    this.name = "ExecError";
    this.command = command;
    this.args = args;
    this.result = result;
  }
};
async function execOrThrow(command, args = [], opts = {}) {
  const result = await exec(command, args, opts);
  if (result.code !== 0) {
    throw new ExecError(command, args, result);
  }
  return result;
}

// src/shared/fs-errors.ts
function isEnoent(err) {
  return err instanceof Error && err.code === "ENOENT";
}

// src/shared/assert.ts
function nonNull(x, msg) {
  if (x == null) {
    throw new Error(msg ?? "unexpected nullish value");
  }
  return x;
}
function at(a, i) {
  return nonNull(a[i], `index ${i} out of range (length ${a.length})`);
}

// src/shared/time.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function nowEpoch() {
  return Math.floor(Date.now() / 1e3);
}

// src/shared/secret-patterns.ts
var SECRET_CONTENT_PATTERNS = [
  { name: "aws-access-key-id", source: "AKIA[0-9A-Z]{16}" },
  { name: "github-pat-classic", source: "ghp_[A-Za-z0-9]{36}" },
  { name: "github-server-token", source: "ghs_[A-Za-z0-9]{36}" },
  { name: "github-oauth-token", source: "gho_[A-Za-z0-9]{36}" },
  { name: "github-refresh-token", source: "ghr_[A-Za-z0-9]{36}" },
  { name: "anthropic-api-key", source: "sk-ant-(api03-)?[A-Za-z0-9_-]{20,}" },
  { name: "openai-style-key", source: "sk-[A-Za-z0-9]{20,}" },
  { name: "slack-token", source: "xox[bpars]-[A-Za-z0-9-]{10,}" },
  { name: "google-api-key", source: "AIza[A-Za-z0-9_-]{35}" },
  { name: "stripe-live-secret", source: "sk_live_[A-Za-z0-9]{20,}" },
  { name: "stripe-live-restricted", source: "rk_live_[A-Za-z0-9]{20,}" },
  {
    name: "jwt",
    source: "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]+"
  },
  {
    name: "aws-secret-access-key",
    source: "aws_secret_access_key\\s*=\\s*[A-Za-z0-9/+=]{40}"
  },
  // Quote-anchored detector — EXCLUDED from redaction (see header note).
  { name: "json-private-key", source: '"private_key"\\s*:\\s*"-----BEGIN' },
  { name: "pem-private-key", source: "-----BEGIN ([A-Z]+ )?PRIVATE KEY-----" },
  { name: "github-pat-fine-grained", source: "github_pat_[A-Za-z0-9_]{60,}" },
  { name: "openai-project-key", source: "sk-proj-[A-Za-z0-9_-]{40,}" },
  { name: "nvidia-api-key", source: "nvapi-[A-Za-z0-9_-]{40,}" },
  { name: "xai-api-key", source: "xai-[A-Za-z0-9]{40,}" }
];
function hasLiteralQuote(p) {
  return p.source.includes('"');
}
var SECRET_REDACTION_PATTERNS = SECRET_CONTENT_PATTERNS.filter(
  (p) => !hasLiteralQuote(p)
);
var REDACTION_TOKEN = "[REDACTED]";
function redactSecrets(text) {
  if (SECRET_REDACTION_PATTERNS.length === 0) {
    return text;
  }
  const combined = SECRET_REDACTION_PATTERNS.map((p) => p.source).join("|");
  const re = new RegExp(combined, "g");
  return text.replace(re, REDACTION_TOKEN);
}
var _KNOWN_PUBLIC_TOKEN_PARTS = [
  // anon role
  [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9",
    "CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
  ],
  // service_role
  [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0",
    "EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
  ]
];
var KNOWN_PUBLIC_TOKENS = _KNOWN_PUBLIC_TOKEN_PARTS.map((p) => p.join("."));

// src/shared/ids.ts
var ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
var SLUG_MAX_LENGTH = 50;
function validateId(id, label = "id") {
  if (id.length === 0) {
    throw new Error(`${label}: empty`);
  }
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${label}: invalid (must match ${ID_PATTERN.source}): ${id}`);
  }
  return id;
}
function slugify(input) {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, SLUG_MAX_LENGTH);
}

// src/shared/paths.ts
function tildeShorten(absPath, home) {
  if (home.length === 0) {
    return absPath;
  }
  if (absPath === home) {
    return "~";
  }
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  if (absPath.startsWith(base + "/")) {
    return "~" + absPath.slice(base.length);
  }
  return absPath;
}

// src/shared/file-lock.ts
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import { mkdir as mkdir2 } from "node:fs/promises";
import { existsSync } from "node:fs";
var log2 = createLogger("lock");
var DEFAULT_FILE_LOCK_TUNING = {
  stale: 15e3,
  // Enough attempts that ≥3 concurrent writers all eventually win their turn.
  retries: 50,
  retryMinTimeout: 20,
  retryMaxTimeout: 500
};
async function withFileLock(opts, fn) {
  if (opts.dirPolicy === "create") {
    await mkdir2(opts.dir, { recursive: true });
  } else if (!existsSync(opts.dir)) {
    throw new Error(`cannot lock ${opts.label} \u2014 dir '${opts.dir}' does not exist`);
  }
  const release = await (0, import_proper_lockfile.lock)(opts.lockfile, {
    realpath: false,
    stale: opts.tuning.stale,
    retries: {
      retries: opts.tuning.retries,
      minTimeout: opts.tuning.retryMinTimeout,
      maxTimeout: opts.tuning.retryMaxTimeout,
      factor: 1.5
    },
    onCompromised: (err) => {
      log2.error(`lock for ${opts.label} was compromised: ${err.message}`);
      throw err;
    }
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

// src/shared/usage-error.ts
var UsageError = class extends Error {
  isUsageError = true;
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
};
function isUsageError(err) {
  return err instanceof UsageError || typeof err === "object" && err !== null && "isUsageError" in err;
}

// src/shared/fs.ts
import { access } from "node:fs/promises";
async function pathExists(absPath) {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

// src/config/schema.ts
var EffortEnum = external_exports.enum(["low", "medium", "high", "xhigh", "max"]);
var QualitySchema = external_exports.object({
  /** Percent of acceptance criteria held out as an unreadable answer-key. */
  holdoutPercent: external_exports.number().min(0).max(100).default(20),
  /** Min pass-rate (%) on the holdout set to clear the gate. */
  holdoutPassRate: external_exports.number().min(0).max(100).default(80),
  /** Target mutation score (%) for the mutation gate. */
  mutationScoreTarget: external_exports.number().min(0).max(100).default(80),
  /** Allowed coverage regression (percentage points) before the gate fails. */
  coverageRegressionTolerancePct: external_exports.number().min(0).default(0.5),
  /** Optional custom SAST/security command (else the built-in semgrep run). */
  securityCommand: external_exports.string().optional(),
  /** Treat security findings as non-blocking when true. */
  securityAllowFailures: external_exports.boolean().default(false),
  /** Redact secrets from the persisted findings artifact (on by default). */
  securityRedactFindings: external_exports.boolean().default(true),
  /**
   * Per-worktree environment-prep command run once after the task worktree is
   * created, BEFORE the deterministic command-gates (test/type/build). When
   * unset, a lockfile in the worktree is auto-detected (`package-lock.json` →
   * `npm ci`, `pnpm-lock.yaml`/`yarn.lock` → frozen install); a repo with no
   * lockfile is a no-op. Set this for non-JS repos or custom setups. Optional.
   */
  setupCommand: external_exports.string().optional(),
  /**
   * Env vars injected into EVERY deterministic gate command (build/test/type/
   * lint/security), merged over `process.env`. Mirror the repo's CI build-step
   * env (e.g. the placeholders a Next.js static prerender needs) so the verifier
   * floor measures the code, not a missing-env build crash. Placeholders only —
   * NOT a secret store. Values are required strings (an explicit "set this var");
   * a numeric-looking value must be quoted as JSON at the `--set` boundary.
   */
  gateEnv: external_exports.record(external_exports.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "valid POSIX env name"), external_exports.string()).default({})
}).default({});
function nonDecreasing(xs) {
  return xs.every((x, i) => i === 0 || x >= at(xs, i - 1));
}
var QuotaSchema = external_exports.object({
  /** 5h-window utilization checkpoints by hour 1..5 (% caps, non-decreasing). */
  hourlyThresholds: external_exports.array(external_exports.number().min(0).max(100)).length(5).refine(nonDecreasing, { message: "thresholds must be non-decreasing" }).default([20, 40, 60, 80, 90]),
  /** 7d-window utilization checkpoints by day 1..7 (% caps, non-decreasing). Ramps to 95% by day 5, plateaus through days 6–7 (5% end-of-window reserve). */
  dailyThresholds: external_exports.array(external_exports.number().min(0).max(100)).length(7).refine(nonDecreasing, { message: "thresholds must be non-decreasing" }).default([20, 40, 60, 80, 95, 95, 95]),
  /**
   * Producer-model dial keyed by risk tier (Decision 25). The quota-router (the
   * renamed model-router, narrowed) selects the producer model for a task from
   * its risk tier; this is the ONLY dial it carries — the review panel is
   * risk-INVARIANT (Decision 25/26), so there is NO review-depth/round cap here
   * (the old `--tier` routine/feature/security review caps are DELETED).
   * Defaults: low/medium→sonnet (balanced), high→opus (strong). low defaults to
   * SONNET, not haiku — even low-risk work is code generation, which haiku
   * underperforms; override `producerModels.low` per-repo for cheaper low-risk runs.
   */
  producerModels: external_exports.object({
    low: external_exports.string().default("claude-sonnet-4-5"),
    medium: external_exports.string().default("claude-sonnet-4-5"),
    high: external_exports.string().default("claude-opus-4-6")
  }).default({})
}).default({});
var SpecSchema = external_exports.object({
  /**
   * The SINGLE spec-review pass threshold out of 60 (Δ I — resolves the legacy
   * 54-vs-56 conflict in favor of 56). `total >= passReviewThreshold` is a
   * candidate PASS, still subject to the per-dimension floor below.
   */
  passReviewThreshold: external_exports.number().int().min(0).max(60).default(56),
  /**
   * Any-dimension auto-fail floor (Δ I): a single rubric dimension scoring
   * `<= dimensionFloor` forces NEEDS_REVISION regardless of the total.
   */
  dimensionFloor: external_exports.number().int().min(0).max(10).default(5),
  /** Max spec generate→review revision iterations before a loud give-up. */
  maxRegenIterations: external_exports.number().int().positive().default(5),
  /** Max bytes of PRD body retained from `gh issue view` before truncation. */
  prdBodyMaxBytes: external_exports.number().int().positive().default(64 * 1024)
}).default({});
var SPEC_DEFAULTS = Object.freeze(SpecSchema.parse({}));
var ReviewSchema = external_exports.object({
  /** Reviewer model id (panel runs on a fixed model per Decision 26). */
  model: external_exports.string().optional(),
  /**
   * Policy when NO cross-vendor (Codex) reviewer is available (S5/C):
   * `warn` records the absence loudly (task state + report + summary);
   * `block` additionally fails the merge gate — a task cannot ship without an
   * independent second-vendor review.
   */
  requireCrossVendor: external_exports.enum(["warn", "block"]).default("warn")
}).default({});
var CodexSchema = external_exports.object({
  model: external_exports.string().optional()
}).default({});
var GitSchema = external_exports.object({
  /**
   * The durable base branch staging forks from and rolls up into. NEVER
   * `main` (Decision 12/16 — the factory never touches main; promotion to main
   * is human-owned and out of scope).
   */
  baseBranch: external_exports.string().min(1).default("develop"),
  /**
   * Required status-check contexts of develop's RUN PROFILE — under
   * `developProtection: "run-scoped"` (default) they are escalated onto
   * develop for the duration of a run (Decision 74); under `"permanent"`
   * they are asserted at scaffold and provisioned with `--provision`.
   * Defaults to the three contexts the rendered quality-gate workflow
   * always reports (Decision 53) — the rollup PR cannot merge red.
   */
  developRequiredStatusChecks: external_exports.array(external_exports.string()).default(["Quality", "Mutation Testing", "Security Scan"]),
  /**
   * Lifecycle of develop's protection profile (Decision 74).
   * `run-scoped` (default): scaffold writes/asserts only the light BASELINE —
   * `developBaselineStatusChecks` required for non-admins, strict off,
   * `enforce_admins` OFF so repo admins can push straight to develop; `run
   * create` escalates to the strict run profile (`developRequiredStatusChecks`
   * + strict + enforce_admins) and every run-terminal path drops back to
   * baseline. `permanent`: the strict profile is provisioned at scaffold and
   * never removed (pre-D74 behavior). NOTE (run-scoped): escalation and
   * de-escalation are full-replace PUTs — custom hand-made protection on
   * develop is clobbered; use `permanent` to opt out.
   */
  developProtection: external_exports.enum(["run-scoped", "permanent"]).default("run-scoped"),
  /**
   * Required status-check contexts of develop's BASELINE profile (run-scoped
   * mode, Decision 74) — enforced on non-admin PRs into develop while NO run
   * is active. Admins bypass (baseline sets `enforce_admins: false`).
   * DERIVED default: `developRequiredStatusChecks` minus `'Mutation Testing'`
   * (the GitSchema transform below) — the baseline drops exactly the mutation
   * gate, so a custom context added to the run profile (e.g. a repo's pgTAP
   * check) stays required at rest with no double-bookkeeping. An explicitly
   * set value (including `[]`) overrides the derivation.
   */
  developBaselineStatusChecks: external_exports.array(external_exports.string()).optional(),
  /**
   * Required status-check contexts provisioned onto each per-run
   * `staging-<run-id>` branch at run create. Default EMPTY: the engine's
   * local GateRunner is the primary task-level enforcement, and a required
   * check here would make every task-PR merge wait on CI wall-clock.
   */
  stagingRequiredStatusChecks: external_exports.array(external_exports.string()).default([]),
  /**
   * Opt-in protection provisioning. OFF by default — the run VERIFIES and
   * REFUSES when protection is missing (#2 / Δ A); only `--provision` flips
   * this to issue the `gh api` PUT.
   */
  provision: external_exports.boolean().default(false),
  /**
   * Branch-name prefix for run-scoped task branches (Δ M). The full name is
   * `<branchPrefix>/<run_id>/<task_id>`.
   */
  branchPrefix: external_exports.string().min(1).default("factory"),
  /**
   * Outer bound (minutes) finalize waits for the rollup PR's full-CI gate
   * before giving up with `ci-timeout`. Sized above the slowest expected
   * quality-gate run (mutation on a cold cache); a timeout still parks the
   * run recoverably (`factory resume` re-enters the poll).
   */
  rollupCiWaitMinutes: external_exports.number().int().positive().default(30)
}).transform((git) => ({
  ...git,
  developBaselineStatusChecks: git.developBaselineStatusChecks ?? git.developRequiredStatusChecks.filter((c) => c !== "Mutation Testing")
})).default({});
var E2eConfigSchema = external_exports.object({
  /**
   * OPTIONAL override (Decision 40 D10) of the command that boots the target app,
   * for both Playwright's `webServer` (test runs) and the e2e-author's
   * live-exploration boot. Normally unset — the run-start assessment resolves it.
   */
  startCommand: external_exports.string().optional(),
  /** OPTIONAL override of the base URL the app serves once booted (D10 — normally
   * assessment-resolved). */
  baseURL: external_exports.string().url().optional(),
  /** Max wait for `startCommand` to become ready before the boot is a failure, ms. */
  readyTimeoutMs: external_exports.number().int().positive().default(3e4),
  /**
   * Per-task cap on e2e-triggered reopens (Decision 39). A critical spec still
   * red after this many reopens of its mapped task fails the run outright
   * instead of looping forever.
   */
  reopenCap: external_exports.number().int().nonnegative().default(2)
}).default({});
var ConfigSchema = external_exports.object({
  quality: QualitySchema,
  quota: QuotaSchema,
  spec: SpecSchema,
  review: ReviewSchema,
  codex: CodexSchema,
  git: GitSchema,
  e2e: E2eConfigSchema,
  /**
   * FLOOR of the circuit-breaker threshold: the run aborts when cumulative genuine
   * capability-budget failures reach `max(this, ceil(0.15 × total tasks))` — big
   * task graphs tolerate proportionally more (≤20 tasks behave as a flat cap of 3).
   * The signal is run-cumulative, not strictly consecutive (the breaker gate counts
   * total capability-budget drops); the field keeps its name for config back-compat.
   */
  maxConsecutiveFailures: external_exports.number().int().positive().default(3),
  /**
   * How many tasks the runner may have in flight at once. Surfaced to the
   * runner on the `kind:"work"` envelope as `max_parallel` (the runner reads
   * the envelope, never this file). Min 1 (1 = sequential, today's behavior).
   */
  maxParallelTasks: external_exports.number().int().positive().default(3),
  /**
   * Minutes an in-flight spawn (`task.spawn_in_flight.spawned_at`) may age
   * before `next-task` flags it in `work.stale` (advisory — a hung agent that
   * died silently is never re-driven inside a live session otherwise). Default
   * 15: stalls are the #1 operational pain (design-review-2026-07-07). Also
   * sizes the runner's heartbeat cron, so keep it under 60 (the usage-cache
   * staleness ceiling — pipeline-runner SKILL).
   */
  stallTtlMinutes: external_exports.number().int().positive().default(15),
  /**
   * HARD wall-clock cap (minutes) on one in-flight spawn. Past this age
   * `next-task` lists the task in `work.hung` (disjoint from `stale`): the
   * runner kills the spawn's agents EVEN IF ALIVE and re-drives — bounded by
   * SPAWN_REDRIVE_CAP (orchestrator.ts), after which the task fails
   * `blocked-environmental` and finalize/rescue-auto take over (Decision 66).
   * Must exceed stallTtlMinutes (the advisory liveness-checked tier below
   * it) — enforced by the superRefine below.
   */
  hungSpawnMinutes: external_exports.number().int().positive().default(120)
}).superRefine((cfg, ctx) => {
  if (cfg.hungSpawnMinutes <= cfg.stallTtlMinutes) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["hungSpawnMinutes"],
      message: `hungSpawnMinutes (${cfg.hungSpawnMinutes}) must exceed stallTtlMinutes (${cfg.stallTtlMinutes}) \u2014 the hard kill-even-if-alive tier sits above the advisory liveness-checked stale band`
    });
  }
}).default({});

// src/config/load.ts
var log3 = createLogger("config");
var PLUGIN_NAME = "factory";
var warnedRedirects = /* @__PURE__ */ new Set();
function expectedDataDir(opts) {
  const { current, home, pluginRoot, warn } = opts;
  if (current == null || current.length === 0) {
    return null;
  }
  const dataRoot = join2(home, ".claude", "plugins", "data");
  if (!current.startsWith(dataRoot + sep)) {
    return null;
  }
  const currentBase = basename2(current);
  if (currentBase === PLUGIN_NAME || currentBase.startsWith(`${PLUGIN_NAME}-`)) {
    return null;
  }
  const pluginFromPath = basename2(dirname2(pluginRoot));
  const marketplaceFromPath = basename2(dirname2(dirname2(pluginRoot)));
  const cacheAnchor = resolve(pluginRoot, "..", "..", "..");
  const expectedCacheRoot = join2(home, ".claude", "plugins", "cache");
  if (cacheAnchor === expectedCacheRoot && pluginFromPath.length > 0 && marketplaceFromPath.length > 0) {
    return join2(dataRoot, `${pluginFromPath}-${marketplaceFromPath}`);
  }
  const marketplaceJson = join2(pluginRoot, ".claude-plugin", "marketplace.json");
  if (existsSync2(marketplaceJson)) {
    try {
      const parsed = parseJson(readFileSync(marketplaceJson, "utf8"), marketplaceJson);
      const name = parsed !== null && typeof parsed === "object" ? parsed.name : void 0;
      const marketplaceName = typeof name === "string" ? name : "";
      if (marketplaceName.length > 0) {
        return join2(dataRoot, `${PLUGIN_NAME}-${marketplaceName}`);
      }
    } catch (err) {
      warn(
        `could not parse ${marketplaceJson} (${err.message}); cannot canonicalize the foreign-plugin data dir \u2014 state may land in a foreign directory. Set CLAUDE_PLUGIN_DATA explicitly to factory's own data dir.`
      );
    }
  }
  return null;
}
function inferPluginRoot() {
  try {
    const here = new URL(".", import.meta.url).pathname;
    let dir = here;
    for (let i = 0; i < 4; i++) {
      if (existsSync2(join2(dir, ".claude-plugin"))) {
        return dir;
      }
      dir = dirname2(dir);
    }
    return resolve(here, "..");
  } catch (err) {
    log3.debug(`inferPluginRoot: ${err.message}; falling back to cwd`);
    return process.cwd();
  }
}
function resolvePluginRoot(env = process.env) {
  const fromEnv = env.CLAUDE_PLUGIN_ROOT;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return inferPluginRoot();
}
function resolveDataDir(opts = {}) {
  if (opts.dataDir != null && opts.dataDir.length > 0) {
    return resolve(opts.dataDir);
  }
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const pluginRoot = opts.pluginRoot ?? inferPluginRoot();
  const current = env.CLAUDE_PLUGIN_DATA;
  const warn = opts.warn ?? ((m) => {
    log3.warn(m);
  });
  const notifyRedirect = opts.warn ?? ((m) => {
    log3.debug(m);
  });
  const corrected = expectedDataDir({ current, home, pluginRoot, warn });
  if (corrected != null && corrected.length > 0 && corrected !== current) {
    const key = JSON.stringify([current ?? "", corrected]);
    if (!warnedRedirects.has(key)) {
      warnedRedirects.add(key);
      notifyRedirect(
        `CLAUDE_PLUGIN_DATA is set to '${current ?? ""}', which belongs to another plugin \u2014 factory auto-redirected to its canonical data dir '${corrected}'. This is benign and self-corrected: no action is required for correctness. To silence this notice permanently, set CLAUDE_PLUGIN_DATA to factory's own dir (e.g. export CLAUDE_PLUGIN_DATA="$HOME/.claude/plugins/data/factory-<your-marketplace-id>").`
      );
    }
    return resolve(corrected);
  }
  if (current == null || current.length === 0) {
    throw new Error(
      'CLAUDE_PLUGIN_DATA must be set (e.g. export CLAUDE_PLUGIN_DATA="$HOME/.claude/plugins/data/factory-<your-marketplace-id>")'
    );
  }
  return resolve(current);
}
function configPath(dataDir) {
  return join2(dataDir, "config.json");
}
function loadConfig(opts = {}) {
  let dataDir;
  try {
    dataDir = resolveDataDir(opts);
  } catch {
    return ConfigSchema.parse({});
  }
  const file = configPath(dataDir);
  if (!existsSync2(file)) {
    return ConfigSchema.parse({});
  }
  const raw = parseJson(readFileSync(file, "utf8"), file);
  warnRetiredKeys(raw, file);
  return ConfigSchema.parse(raw);
}
var RETIRED_KEYS = [
  ["git", "stagingBranch"],
  ["e2e", "testDir"]
];
var retiredKeyWarned = /* @__PURE__ */ new Set();
function warnRetiredKeys(raw, file) {
  if (typeof raw !== "object" || raw === null) {
    return;
  }
  for (const [section, key] of RETIRED_KEYS) {
    const sectionVal = raw[section];
    if (typeof sectionVal === "object" && sectionVal !== null && key in sectionVal) {
      const id = `${file}:${section}.${key}`;
      if (!retiredKeyWarned.has(id)) {
        retiredKeyWarned.add(id);
        log3.warn(
          `config: '${section}.${key}' is retired and ignored (${file}) \u2014 remove it (factory configure --unset ${section}.${key})`
        );
      }
    }
  }
}

// src/config/save.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { mkdir as mkdir3 } from "node:fs/promises";
function readRawConfig(opts = {}) {
  const file = configPath(resolveDataDir(opts));
  if (!existsSync3(file)) {
    return {};
  }
  const parsed = parseJson(readFileSync2(file, "utf8"), file);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config: ${file} is not a JSON object`);
  }
  return parsed;
}
async function saveRawConfig(raw, opts = {}) {
  const resolved = ConfigSchema.parse(raw);
  const dataDir = resolveDataDir(opts);
  await mkdir3(dataDir, { recursive: true });
  await atomicWriteFile(configPath(dataDir), stringifyJson(raw));
  return resolved;
}
function parseSetToken(token) {
  const eq = token.indexOf("=");
  if (eq <= 0) {
    throw new Error(`configure: --set expects 'key.path=value', got '${token}'`);
  }
  const path3 = splitPath(token.slice(0, eq));
  const rawValue = token.slice(eq + 1);
  return { path: path3, value: coerceValue(rawValue) };
}
function coerceValue(raw) {
  try {
    return parseJson(raw);
  } catch {
    return raw;
  }
}
function splitPath(dotted) {
  const path3 = dotted.split(".");
  if (path3.length === 0 || path3.some((s) => s.length === 0)) {
    throw new Error(`configure: invalid key path '${dotted}'`);
  }
  return path3;
}
function setAtPath(obj, path3, value) {
  const next = structuredClone(obj);
  let cursor = next;
  for (let i = 0; i < path3.length - 1; i++) {
    const key = at(path3, i);
    const existing = cursor[key];
    if (existing === void 0 || existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[at(path3, path3.length - 1)] = value;
  return next;
}
function unsetAtPath(obj, path3) {
  const next = structuredClone(obj);
  const parents = [];
  let cursor = next;
  for (let i = 0; i < path3.length - 1; i++) {
    const key = at(path3, i);
    const child = cursor[key];
    if (child === void 0 || child === null || typeof child !== "object" || Array.isArray(child)) {
      return next;
    }
    parents.push({ container: cursor, key });
    cursor = child;
  }
  Reflect.deleteProperty(cursor, at(path3, path3.length - 1));
  for (let i = parents.length - 1; i >= 0; i--) {
    const { container, key } = at(parents, i);
    const child = container[key];
    if (Object.keys(child).length === 0) {
      Reflect.deleteProperty(container, key);
    } else {
      break;
    }
  }
  return next;
}
function getAtPath(config, path3) {
  let cursor = config;
  for (const key of path3) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      throw new Error(`configure: '${path3.join(".")}' has no value (not an object at '${key}')`);
    }
    if (!(key in cursor)) {
      throw new Error(`configure: unknown config key '${path3.join(".")}'`);
    }
    cursor = cursor[key];
  }
  return cursor;
}

// src/types/phases-vocab.ts
var TASK_PHASES = ["preflight", "tests", "exec", "verify", "ship"];
var SPAWN_PHASES = ["tests", "exec", "verify"];

// src/core/state/schema.ts
var RunStatusEnum = external_exports.enum(["running", "completed", "superseded", "paused", "suspended", "failed"]);
var TERMINAL_RUN_STATUSES = ["completed", "failed", "superseded"];
function isTerminalRunStatus(s) {
  return TERMINAL_RUN_STATUSES.includes(s);
}
var TaskStatusEnum = external_exports.enum(["pending", "executing", "reviewing", "shipping", "done", "failed"]);
var FailureClassEnum = external_exports.enum([
  "capability-budget",
  "spec-defect",
  "blocked-environmental",
  "needs-context",
  "blocked-dependency"
]);
var RiskTierEnum = external_exports.enum(["low", "medium", "high"]);
var EscalationRungSchema = external_exports.number().int().min(0);
var PanelVerdictEnum = external_exports.enum(["approve", "blocked", "error"]);
var ProducerRoleEnum = external_exports.enum(["test-writer", "implementer"]);
var SpecPointerSchema = external_exports.object({
  /** Repo identity, e.g. "owner/name". The first key of (repo, spec-id). */
  repo: external_exports.string().min(1),
  /** `<issue>-<slug>`. The second key of (repo, spec-id). */
  spec_id: external_exports.string().min(1),
  /** The PRD issue number — the STABLE lookup key embedded in spec_id. */
  issue_number: external_exports.number().int().positive()
});
var ReviewerResultSchema = external_exports.object({
  /** Reviewer identity (e.g. "implementation", "security", "silent-failure"). */
  reviewer: external_exports.string().min(1),
  /** This reviewer's verdict after verify-then-fix adjudication. */
  verdict: PanelVerdictEnum,
  /** Pointer to the review artifact (relative to the run's reviews/ dir). */
  artifact: external_exports.string().optional(),
  /** Number of confirmed (verified) blocking findings this reviewer raised. */
  confirmed_blockers: external_exports.number().int().min(0).default(0)
});
var FixFindingSchema = external_exports.object({
  /** Origin of the finding: a reviewer name (e.g. "security") or a gate id (e.g. "lint"). */
  reviewer: external_exports.string().min(1),
  file: external_exports.string().optional(),
  line: external_exports.number().int().positive().optional(),
  description: external_exports.string().min(1)
}).superRefine((finding, ctx) => {
  const hasFile = finding.file !== void 0;
  const hasLine = finding.line !== void 0;
  if (hasFile && !hasLine) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["line"],
      message: `finding has 'file' but no 'line' \u2014 provide both or neither for a citable finding`
    });
  }
  if (hasLine && !hasFile) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["file"],
      message: `finding has 'line' but no 'file' \u2014 provide both or neither for a citable finding`
    });
  }
});
var ReviewDispositionSchema = external_exports.object({
  /** Which reviewer raised the original finding. */
  reviewer: external_exports.string().min(1),
  /** Why it does not gate: verifier-refuted, or raised non-blocking. */
  disposition: external_exports.enum(["refuted", "non-blocking"]),
  file: external_exports.string().optional(),
  line: external_exports.number().int().positive().optional(),
  /** The verbatim quote from the original finding (fingerprint half 1). */
  quote: external_exports.string().min(1),
  /** The one-sentence claim from the original finding (fingerprint half 2). */
  claim: external_exports.string().min(1),
  /** The refutation reason (refuted entries only). */
  note: external_exports.string().optional(),
  /** The verify round (attempt) that adjudicated it. */
  round: external_exports.number().int().positive()
});
var TaskStateSchema = external_exports.object({
  task_id: external_exports.string().min(1),
  status: TaskStatusEnum.default("pending"),
  /**
   * Task ids this task depends on (the vertical-slice DAG, Decision 23). A
   * deliberate denormalization: copied from the {@link SpecTask} at seed time and
   * then frozen (never mutated), so the hot DAG-traversal readers — `next.ts`
   * (ready-task selection) and `rescue/scan.ts` (drift scan, which has NO spec in
   * scope) — read edges straight off run state without coupling to the spec store.
   * Integrity is pinned at seed time by `seedTasksFromSpec`, where dangling, self,
   * cyclic, and duplicate edges all fail LOUD.
   */
  depends_on: external_exports.array(external_exports.string()).default([]),
  // --- Producer ladder (Decision 25; the risk_tier dial lives on the SpecTask, not here) ---
  /** Current rung on the producer escalation ladder (0 = starting rung). */
  escalation_rung: EscalationRungSchema.default(0),
  /** Which producer role is/last ran. */
  producer_role: ProducerRoleEnum.optional(),
  /**
   * Defect feedback carried from the implementer's `test-defective` escalation into
   * the NEXT test-writer re-run (the test-revision recovery, Δ D). Set when the
   * implementer reports the RED test is wrong; injected into the regenerated
   * test-writer's prior-failure context (handlers.tests) so it does not re-pin the
   * same wrong literal; cleared once the test-writer returns `done`. Absent
   * otherwise. Transient — not a failure field (allowed on any status).
   */
  test_revision_feedback: external_exports.string().optional(),
  /**
   * The producer's open NEEDS_CONTEXT question (Decision 69). Written on the
   * first NEEDS_CONTEXT at a phase (the task re-spawns ONCE at the same rung with
   * the question injected); a second consecutive NEEDS_CONTEXT fails the task
   * `needs-context` with the question refreshed. `answer` is written only by
   * `rescue apply --answer` and is injected alongside the question on the
   * post-reset re-spawn. Cleared when a producer returns `done` (any role — a
   * completed attempt resolves the question by construction). Deliberately
   * PRESERVED by rescue's resetTaskRow (unlike most transients): the open
   * question is the whole point of the reset. Transient — allowed on any status.
   */
  needs_context: external_exports.object({
    question: external_exports.string().min(1),
    answer: external_exports.string().min(1).optional()
  }).optional(),
  /**
   * The failing gate-id set of the LAST blocked merge-gate verify (sorted,
   * holdout excluded — Decision 71). An event record like `fix_findings`
   * (the reviewers it derives from are cleared by escalateOrFail). When the next
   * blocked verify fails the IDENTICAL set, the escalation is routed to the
   * `tests` phase (the RED test is suspected as the broken arbiter) instead of
   * re-rolling the implementer. Cleared on the advancing verify write, on
   * doneTaskRow, and by rescue's resetTaskRow. Transient — allowed on any status.
   */
  last_failing_gates: external_exports.array(external_exports.string().min(1)).optional(),
  /**
   * Feedback carried from a failing e2e journey spec into this task's NEXT
   * implementation pass (the e2e reopen loop, Decision 39). Set by the e2e coroutine
   * when it maps a failing spec to this task via the author manifest and resets the
   * task to `pending`; injected into the regenerated producer's prior-failure context
   * (mirrors `test_revision_feedback`, but originates from a RUN-LEVEL phase, not a
   * per-task producer outcome). Cleared once the task ships again. Absent otherwise.
   * Transient — not a failure field (allowed on any status).
   */
  e2e_feedback: external_exports.string().optional(),
  /**
   * Fix-forward instructions carried from a blocked merge-gate verify into the
   * NEXT producer (`exec`) rung (D5 fix-forward channel). Composed at the
   * wait-retry branch (`record.ts`) from confirmed reviewer blockers ∪ non-holdout
   * failing gate evidence, persisted BEFORE `escalateOrFail` clears `reviewers`
   * (mirrors the `test_revision_feedback` precedent: a separate write ahead of the
   * ladder transition). `handlers.ts`'s `exec` reads it into `buildProducerContext`
   * as `confirmedBlockers`. Cleared on the next advance/complete. Absent otherwise.
   * Transient — not a failure field (allowed on any status).
   */
  fix_findings: external_exports.array(FixFindingSchema).optional(),
  /**
   * Anti-ratcheting disposition ledger (Decision 68): claims a prior verify round
   * refuted or raised non-blocking, appended at the wait-retry branch (record.ts,
   * same separate-write pattern as `fix_findings`) and injected into the NEXT
   * round's panel reviewer prompts so a fresh-context reviewer cannot blindly
   * re-raise an already-dismissed claim. Survives `escalateOrFail`'s `{...t}`
   * spread across rung bumps; cleared when the task ships (doneTaskRow) and on
   * the advancing verify write. Transient — allowed on any status.
   */
  review_dispositions: external_exports.array(ReviewDispositionSchema).optional(),
  // --- Merge gate (Decision 26/27) ---
  /** Per-reviewer panel results (derive.ts computes the merge-gate verdict from these). */
  reviewers: external_exports.array(ReviewerResultSchema).default([]),
  /**
   * Δ U/S5 — set IFF the ADVANCING verify pass ran WITHOUT an independent
   * cross-vendor reviewer (runPanel's crossVendorAbsence). An EVENT RECORD like
   * `reviewers[]` (derive-don't-store exception: which executor actually reviewed
   * is not derivable after the fact). Written/cleared in the SAME advance write
   * as `reviewers`; surfaced by the partial report + run summary.
   */
  cross_vendor_absent: external_exports.object({ reason: external_exports.string().min(1) }).optional(),
  // --- Git / PR pointers (WS3 populates; schema reserves the shape) ---
  /** Run-scoped branch `factory/<run_id>/<task_id>` (Δ M). */
  branch: external_exports.string().optional(),
  /** PR number once created (idempotent-create keyed off branch, Δ P). */
  pr_number: external_exports.number().int().positive().optional(),
  // --- Failure classification (Decision 22, Δ D) ---
  /** Set IFF status === "failed": the closed-enum cause. */
  failure_class: FailureClassEnum.optional(),
  /** Human-facing reason string accompanying a fail. */
  failure_reason: external_exports.string().optional(),
  /**
   * The precise resume cursor for the drive orchestrator — which TaskPhase the task is
   * at/resuming at. Written by markInFlight. Lossy `status` stays the human-facing
   * summary; `phase` is the machine cursor. Absent = not started (preflight).
   * NOTE: on terminal rows (done/failed), `phase` is the last in-flight phase,
   * not a resume point — terminal writers do not clear it.
   * NOTE: both this enum and phase-machine's TASK_PHASE_ORDER import the SAME
   * literal tuple from `types/phases-vocab.ts` (the dependency-free vocabulary
   * leaf), so they cannot drift; the cross-check test in
   * src/orchestrator/orchestrator.test.ts is belt-and-braces, not load-bearing.
   */
  phase: external_exports.enum(TASK_PHASES).optional(),
  /** Ship live-merge re-sync count (cap enforced by the orchestrator; persisted so the cap survives process boundaries). */
  merge_resyncs: external_exports.number().int().min(0).default(0),
  /**
   * Same-rung verify re-runs consumed for holdout EVALUATOR failures (malformed
   * validator output — unparseable/wrong-cardinality/mismatched/blank-evidence-pass).
   * Distinct from `spawn_in_flight.redrives` (hung-spawn respawn, Decision 66): this
   * counts delivered-but-broken evaluator output. Cap enforced in record.ts
   * (HOLDOUT_EVALUATOR_RETRY_CAP); exhaustion fails the task `blocked-environmental`.
   * Absent = 0.
   */
  holdout_evaluator_retries: external_exports.number().int().min(0).optional(),
  /**
   * Spawn-in-flight checkpoint (idempotent re-spawn). Set by the orchestrator when it
   * EMITS a spawn for `phase` at `rung`, recording the task-branch `tip_sha` at emit
   * time. Producers commit to the SHARED task worktree, so a stop in the post-spawn /
   * pre-record window leaves the abandoned producer's partial commits on the branch. On
   * the resume that re-enters the SAME (phase, rung) before any results were recorded,
   * the orchestrator resets the worktree to `tip_sha` — discarding ONLY the interrupted
   * phase's work (prior completed phases live below it) — then re-spawns. A fresh
   * spawn overwrites it; terminal writers (complete/fail) clear it. Absent = no spawn
   * in flight (the steady state between phases).
   *
   * `phase` is the spawn-phase subset (tests|exec|verify) — preflight/ship never spawn.
   * Both this enum and orchestrator/results' SPAWN_PHASES import the same tuple from
   * `types/phases-vocab.ts`, so they cannot drift (the orchestrator.test.ts cross-check
   * is belt-and-braces, mirroring the `phase` field's pin).
   */
  spawn_in_flight: external_exports.object({
    phase: external_exports.enum(SPAWN_PHASES),
    rung: external_exports.number().int().min(0),
    tip_sha: external_exports.string().min(1),
    /** Epoch SECONDS (the shared quota clock, `OrchestratorDeps.now()`) at
     * spawn emit; refreshed on a matching re-entry. Stall-TTL detection
     * (`next.ts` `work.stale`/`work.hung`) reads this — advisory only, no
     * status change. Defaults to 0 (epoch) so a pre-S? checkpoint persisted
     * before this field existed parses as maximally aged — it lands in `hung`
     * (kill + re-drive) — correct: an untimed in-flight spawn should be
     * flagged for re-drive, not silently trusted. */
    spawned_at: external_exports.number().default(0),
    /**
     * Matching (phase, rung) re-entries already consumed — the bound on the
     * kill→respawn→hang loop (Decision 66). Incremented by the orchestrator's
     * re-entry branch; a fresh checkpoint (any phase/rung advance) is written
     * with 0, so the budget is per-(phase, rung) by construction. Defaults to
     * 0 so a checkpoint persisted before this field existed parses with a
     * FULL budget — safe: the cap bounds FUTURE re-entries only (the opposite
     * gotcha from spawned_at, whose default-0 must read as maximally aged).
     */
    redrives: external_exports.number().int().min(0).default(0)
  }).optional(),
  // --- Lifecycle timestamps (ISO-8601) ---
  started_at: external_exports.string().optional(),
  ended_at: external_exports.string().optional()
});
function refineTaskCrossFields(task, ctx) {
  const isFailed = task.status === "failed";
  if (isFailed && task.failure_class == null) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["failure_class"],
      message: `task '${task.task_id}' is 'failed' but has no failure_class (a fail must be classified)`
    });
  }
  if (!isFailed && task.failure_class != null) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["failure_class"],
      message: `task '${task.task_id}' has failure_class '${task.failure_class}' but status is '${task.status}' (failure_class is set IFF failed)`
    });
  }
  const hasReason = task.failure_reason != null && task.failure_reason.length > 0;
  if (isFailed && !hasReason) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["failure_reason"],
      message: `task '${task.task_id}' is 'failed' but has no failure_reason (a fail must carry a human-facing reason)`
    });
  }
  if (!isFailed && task.failure_reason != null) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["failure_reason"],
      message: `task '${task.task_id}' has a failure_reason but status is '${task.status}' (failure_reason is set IFF failed)`
    });
  }
  task.reviewers.forEach((r, i) => {
    if (r.verdict === "approve" && r.confirmed_blockers !== 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["reviewers", i, "confirmed_blockers"],
        message: `reviewer '${r.reviewer}' approves but records ${r.confirmed_blockers} confirmed blocker(s) (approve \u21D2 0)`
      });
    }
    if (r.verdict === "blocked" && r.confirmed_blockers === 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["reviewers", i, "confirmed_blockers"],
        message: `reviewer '${r.reviewer}' is blocked but records 0 confirmed blockers (blocked \u21D2 \u22651)`
      });
    }
  });
  const inFlight = task.status === "executing" || task.status === "reviewing" || task.status === "shipping";
  if (inFlight && task.phase === void 0) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["phase"],
      message: `task '${task.task_id}' has in-flight status '${task.status}' but no phase cursor \u2014 phase is written in lockstep with status (state from an older factory version); start a fresh run`
    });
  }
  if (task.spawn_in_flight !== void 0 && task.spawn_in_flight.rung > task.escalation_rung) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["spawn_in_flight", "rung"],
      message: `task '${task.task_id}' spawn_in_flight.rung (${task.spawn_in_flight.rung}) > escalation_rung (${task.escalation_rung}) \u2014 rung went backward, stale checkpoint from before a rescue reset`
    });
  }
}
var TaskStateChecked = TaskStateSchema.superRefine(refineTaskCrossFields);
var QuotaCheckpointSchema = external_exports.discriminatedUnion("binding_window", [
  external_exports.object({ binding_window: external_exports.literal("5h"), resets_at_epoch: external_exports.number().int().nonnegative() }),
  external_exports.object({ binding_window: external_exports.literal("7d"), resets_at_epoch: external_exports.number().int().nonnegative() }),
  external_exports.object({ binding_window: external_exports.literal("unavailable") })
]);
function concludedPhaseMarker(afterReason, afterAttempts) {
  return external_exports.object({
    status: external_exports.enum(["done", "failed"]),
    reason: external_exports.string().optional(),
    ...afterReason,
    attempts: external_exports.number().int().nonnegative().optional(),
    ...afterAttempts,
    ended_at: external_exports.string()
  });
}
function openPhaseMarker(afterReason, afterAttempts) {
  return external_exports.object({
    status: external_exports.enum(["done", "failed"]).optional(),
    reason: external_exports.string().optional(),
    ...afterReason,
    attempts: external_exports.number().int().nonnegative().optional(),
    ...afterAttempts,
    ended_at: external_exports.string().optional()
  });
}
var DocsPhaseSchema = concludedPhaseMarker({}, {});
var TraceabilityVerdictRowSchema = external_exports.object({
  requirement: external_exports.string().min(1),
  verdict: external_exports.enum(["met", "partial", "unmet"]),
  evidence: external_exports.string().min(1)
});
var TraceabilityPhaseSchema = concludedPhaseMarker(
  {},
  {
    /** One row per PRD requirement; empty ⇔ no parseable audit ever landed. */
    verdicts: external_exports.array(TraceabilityVerdictRowSchema).default([])
  }
);
var E2eSpecKindEnum = external_exports.enum(["critical", "throwaway"]);
var E2eManifestEntrySchema = external_exports.object({
  /** Task id(s) this spec exercises (a critical journey spec may span >1 task). */
  task_ids: external_exports.array(external_exports.string().min(1)).min(1),
  /** Spec file path — repo-relative for `critical`, run-ephemeral-dir-relative for `throwaway`. */
  spec_path: external_exports.string().min(1),
  kind: E2eSpecKindEnum,
  /**
   * Human-readable journey name (Decision 40 D12) — surfaces in the run report's
   * "journeys covered" section so a zero-e2e-knowledge operator can read what was
   * proven. Optional: pre-D12 manifests lack it (renderer falls back to spec_path).
   */
  title: external_exports.string().min(1).optional()
});
var E2eAdjudicationSpecSchema = external_exports.object({
  /** Repo-relative path of the failing committed spec. */
  spec_path: external_exports.string().min(1),
  /** The failing spec's human-readable title (from the Playwright results). */
  title: external_exports.string(),
  /** The failing assertion/step detail (D8), threaded into the adjudicator prompt. */
  error: external_exports.string().optional(),
  mode: external_exports.enum(["adjudicate", "update"])
});
var E2eAdjudicationSchema = external_exports.object({
  specs: external_exports.array(E2eAdjudicationSpecSchema).min(1),
  /** Adjudicator SPAWN attempts (crash retry, mirrors `author_attempts`). */
  attempts: external_exports.number().int().nonnegative(),
  requested_at: external_exports.string()
});
var E2ePhaseSchema = openPhaseMarker(
  {
    /**
     * Non-gating note surfaced on a `done` phase — e.g. residual THROWAWAY red that
     * didn't block completion (Decision 39: only critical red gates). Distinct from
     * `reason`, which the T2 cross-field check reserves for `failed` (set IFF
     * failed) — `advisory` is the `done`-side counterpart, never present on `failed`.
     */
    advisory: external_exports.string().optional()
  },
  {
    /**
     * Author SPAWN attempts (Decision 40 D5): a crashed/unparseable author earns ONE
     * automatic re-spawn before the phase fails; distinct from `attempts` (suite
     * passes). Deliberate blocked-escalate/needs-context verdicts never retry.
     */
    author_attempts: external_exports.number().int().nonnegative().optional(),
    /** The author's spec→task manifest, fixed once authored and reused across passes. */
    manifest: external_exports.array(E2eManifestEntrySchema).default([]),
    /** Per-task reopen count so far, keyed by task_id — bounds each task by `e2e.reopenCap`. */
    reopen_counts: external_exports.record(external_exports.string(), external_exports.number().int().nonnegative()).default({}),
    /** In-flight adjudication cursor (D7) — see {@link E2eAdjudicationSchema}. */
    adjudication: E2eAdjudicationSchema.optional(),
    /**
     * Per-spec adjudication count, keyed by spec_path (D7 cap: 1 per spec per run).
     * A spec failing AGAIN after its one adjudication is a regression — the run
     * fails rather than adjudicating in a loop. Survives rescue's reset (like
     * `reopen_counts`): the cap holds across the whole run.
     */
    adjudication_counts: external_exports.record(external_exports.string(), external_exports.number().int().nonnegative()).optional()
  }
);
var E2eAffectedSpecSchema = external_exports.object({
  /** Repo-relative path of the existing committed spec. */
  spec_path: external_exports.string().min(1),
  /** Task id(s) in THIS run whose work touches the spec's journey. */
  task_ids: external_exports.array(external_exports.string().min(1)).min(1),
  expectation: external_exports.enum(["needs-update", "should-still-pass"])
});
var E2eAssessmentSchema = openPhaseMarker(
  {
    /** Degraded-coverage note on a `done` assessment (e.g. logged-out coverage only). */
    warning: external_exports.string().optional(),
    /** Boot config the assessor resolved + wrote into `playwright.config.ts` (D10). */
    resolved: external_exports.object({
      start_command: external_exports.string().min(1).optional(),
      base_url: external_exports.string().min(1).optional()
    }).optional(),
    /** Coverage forecast over EXISTING committed specs (empty when none exist). */
    affected_specs: external_exports.array(E2eAffectedSpecSchema).default([])
  },
  {}
);
var ExecutionModeEnum = external_exports.enum(["sequential", "balanced"]);
var ShipModeEnum = external_exports.enum(["no-merge", "live"]);
var MissSchema = external_exports.object({
  /** The task whose shipped code the miss traces to (∈ run.tasks — refined below). */
  task_id: external_exports.string().min(1),
  /** ISO-8601 record time, stamped by the CLI. */
  at: external_exports.string(),
  /** REQUIRED human description — a miss without one is noise. */
  note: external_exports.string().min(1),
  /**
   * Human judgment: which reviewer lens SHOULD have caught it (a panel role), or
   * 'none' when no lens could have. Stays a bare string here — a frozen state schema
   * must not import the verifier's panel roster; the `factory miss` CLI validates
   * it against `panelRolesFor(true) ∪ {'none'}`.
   */
  lens: external_exports.string().min(1).optional()
});
var RunStateSchema = external_exports.object({
  /** State-schema version (independent of plugin version). */
  schema_version: external_exports.literal(3).default(3),
  /** `run-YYYYMMDD-HHMMSS`. */
  run_id: external_exports.string().min(1),
  status: RunStatusEnum.default("running"),
  execution_mode: ExecutionModeEnum.default("sequential"),
  ship_mode: ShipModeEnum.default("live"),
  /**
   * The Claude Code session id that OWNS this run. MANDATORY at `run create` —
   * resolution (`--session-id` flag, else `CLAUDE_CODE_SESSION_ID`) failing is a
   * UsageError, so every new run is owned. The schema keeps the field optional
   * only for legacy persisted runs created before the requirement. The Stop hook
   * uses it to scope a resumability HINT to the owning session (`findActiveByOwner`
   * never matches an ownerless run) — it never blocks, and there is no unscoped
   * fallback (see hooks/stop-gate.ts). An immutable property, never a derived verdict.
   */
  owner_session: external_exports.string().min(1).optional(),
  /**
   * The per-run staging branch this run cut + pushed (`staging-<run-id>`). PINNED
   * ONCE at `run create` (Decision 33) so every later base-ref resolution — worktree
   * fork point, deterministic-gate diff base, reviewer/holdout inspect ref, ship
   * merge target, rollup source — reads the branch the run ACTUALLY created, not a
   * value recomputed by `runStagingBranch(run_id)`. A mid-run naming-scheme change
   * (e.g. the slashed→flat rename) would otherwise silently desync the recompute from
   * the already-pushed branch. Git provenance / immutable identity — NOT a derived
   * verdict, so derive-don't-store does not apply.
   */
  staging_branch: external_exports.string().min(1),
  /** Pointer to the durable spec (Δ X) — NOT an embedded spec. */
  spec: SpecPointerSchema,
  /** Per-task state, keyed by task_id (cross-field checks applied per task). */
  tasks: external_exports.record(external_exports.string(), TaskStateChecked).default({}),
  /**
   * When true, the quota gate skips pacing and returns null unconditionally. Set once at
   * `run create` from `--ignore-quota`, or toggled true by `factory resume --ignore-quota`.
   * Persisted so both orchestrators skip the gate without per-call flag threading.
   * Default false: legacy runs (no field) are unaffected.
   */
  ignore_quota: external_exports.boolean().default(false),
  /** Quota resume checkpoint (Decision 24); absent until a pause/suspend. */
  quota: QuotaCheckpointSchema.optional(),
  /**
   * Bounded auto-rescue ledger (S10, Decision 48). Stamped INSIDE the same locked
   * `applyRescue` mutation that performs an `--auto` reset. A sanctioned
   * stored-EVENT exception to derive-don't-store (precedent: the retired
   * `paused_minutes`): "how many self-heal cycles already ran" is history no
   * state/git re-derivation can recover. `factory rescue auto` requires
   * `attempts < SELF_HEAL_MAX_ATTEMPTS`, bounding the self-heal loop to ≤3
   * cycles per run (Decision 60; each failed finalize spends one).
   */
  self_heal: external_exports.object({
    attempts: external_exports.number().int().nonnegative(),
    last_at: external_exports.string()
  }).optional(),
  /**
   * Human-intervention ledger (S11): one entry per human action on the run —
   * `launch` (run create), `conflict` (a `--supersede` resolution, stamped on the
   * NEW run alongside its launch), `resume` (a human resume clearing a park),
   * `recover` (an approved rescue apply that did work). The second sanctioned
   * stored-EVENT exception (with `self_heal`): which touches happened is history
   * nothing can re-derive. `--auto` self-heal NEVER appends — it is not a human.
   * The touch METRIC stays derived: `(completed ? 1 : 0) / touches.length`,
   * guarded to n/a on an empty ledger — never a fabricated number.
   */
  human_touches: external_exports.array(
    external_exports.object({
      kind: external_exports.enum(["launch", "conflict", "resume", "recover"]),
      at: external_exports.string()
    })
  ).default([]),
  /**
   * review-miss ledger (Decision 61): one entry per human-reported defect in
   * shipped factory-produced code, post-merge. The THIRD sanctioned stored-EVENT
   * exception to derive-don't-store (with `self_heal` + `human_touches`) — "a human
   * found this in shipped code" is history nothing can re-derive. Appended by
   * `factory miss`; `factory score` derives the miss metrics from it. Default []:
   * legacy runs (no field) carry no misses.
   */
  misses: external_exports.array(MissSchema).default([]),
  /** Documentation phase marker; absent until the docs phase runs (engine docs phase). */
  docs: DocsPhaseSchema.optional(),
  /** PRD-traceability phase marker (S9); absent until the phase runs. */
  traceability: TraceabilityPhaseSchema.optional(),
  /**
   * Whether this run opted into the e2e phase (the `--e2e` flag). Set once at
   * `run create`; immutable for the run's lifetime — mirrors `ignore_quota`.
   * Default false: a run without the flag never gates on `wantsE2e()`.
   */
  e2e: external_exports.boolean().default(false),
  /** E2E phase marker + author manifest; absent until the e2e phase first runs. */
  e2e_phase: E2ePhaseSchema.optional(),
  /** Run-start e2e assessment record (Decision 40 D3); absent until it first spawns. */
  e2e_assessment: E2eAssessmentSchema.optional(),
  /**
   * The `completed` run's staging→develop rollup outcome, persisted at finalize
   * ONLY when it did not land (`merged:false`). Two shapes: (a) an armed-but-not-
   * landed rollup PR (`number` present — e.g. the "auto-armed" branch-policy
   * fallback, D3; the run went terminal at step 7); (b) a forward-reconcile merge
   * CONFLICT before any rollup PR exists (`number` absent; finalize threw, run
   * stays NON-terminal). Absent on a merged rollup (nothing to recover) or a
   * `failed` run (no rollup attempted). Lets `rescue scan` flag either case
   * (`rollup_pending`) without a live GitHub call. Recovery: (a) `rescue apply
   * --recheck-rollup` reopens the run so a re-drive re-enters `finalizeRun`,
   * whose rollup() resume-guard finds the now-merged PR; (b) human resolves the
   * staging↔develop conflict, then plain `factory resume` re-enters finalize,
   * which overwrites/clears this marker with the real rollup result.
   */
  rollup: external_exports.object({
    /** Rollup PR number; absent when the block precedes PR creation (reconcile conflict). */
    number: external_exports.number().int().positive().optional(),
    merged: external_exports.boolean(),
    reason: external_exports.string().optional()
  }).optional(),
  /**
   * Whether this run is a `/factory:debug` session. Set once at `run create`;
   * immutable for the run's lifetime — mirrors `e2e`/`ignore_quota`. A `debug:true`
   * run loops through multiple review⇄fix passes before finalizing, so it defers
   * `run finalize` (the PRD comment/close) to the debug driver instead of the plain
   * runner loop, and the Stop gate skips even its resumability hint for it. Default
   * false: a run without the flag finalizes exactly as before.
   */
  debug: external_exports.boolean().default(false),
  /**
   * WHY the run went terminal as `failed`/`superseded` — a one-line human-facing
   * cause (evaluator exhaustion, e2e phase failure, operator cancel, superseding
   * run id, …). Written ONLY by `StateManager.finalize`, which REQUIRES it for
   * failed/superseded and FORBIDS it for completed; the schema keeps it optional
   * so legacy terminal states (written before the field existed) still parse —
   * they display "reason unavailable". A stored terminal EVENT, not a derived
   * verdict: the cause at flip time is history nothing can re-derive.
   */
  terminal_reason: external_exports.string().min(1).optional(),
  /** Lifecycle timestamps (ISO-8601). */
  started_at: external_exports.string(),
  updated_at: external_exports.string(),
  ended_at: external_exports.string().nullable().default(null)
});
function reasonIffFailed(ctx, opts) {
  const isFailed = opts.status === "failed";
  const hasReason = opts.reason != null && opts.reason.length > 0;
  if (isFailed && !hasReason) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: [...opts.path],
      message: `run '${opts.runId}' ${opts.label} is 'failed' but has no reason`
    });
  }
  if (!isFailed && hasReason) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: [...opts.path],
      message: `run '${opts.runId}' ${opts.label} is '${opts.status}' but carries a reason (reason is set IFF failed)`
    });
  }
}
function refineRunCrossFields(run5, ctx) {
  if (run5.quota != null) {
    const wanted = run5.quota.binding_window === "5h" ? "paused" : "suspended";
    if (run5.status !== wanted) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["quota"],
        message: `run '${run5.run_id}' carries a '${run5.quota.binding_window}' quota checkpoint but status is '${run5.status}' (a '${run5.quota.binding_window}' checkpoint pairs with '${wanted}')`
      });
    }
  }
  if (isTerminalRunStatus(run5.status) !== (run5.ended_at != null)) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["ended_at"],
      message: isTerminalRunStatus(run5.status) ? `run '${run5.run_id}' is terminal ('${run5.status}') but has no ended_at` : `run '${run5.run_id}' is '${run5.status}' (non-terminal) but carries ended_at`
    });
  }
  if (run5.terminal_reason !== void 0 && run5.status !== "failed" && run5.status !== "superseded") {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["terminal_reason"],
      message: `run '${run5.run_id}' is '${run5.status}' but carries terminal_reason (only failed|superseded may)`
    });
  }
  if (run5.docs !== void 0) {
    reasonIffFailed(ctx, {
      runId: run5.run_id,
      path: ["docs", "reason"],
      label: "docs phase",
      status: run5.docs.status,
      reason: run5.docs.reason
    });
  }
  if (run5.traceability !== void 0) {
    reasonIffFailed(ctx, {
      runId: run5.run_id,
      path: ["traceability", "reason"],
      label: "traceability phase",
      status: run5.traceability.status,
      reason: run5.traceability.reason
    });
    if (run5.traceability.status === "done" && run5.traceability.verdicts.some((v) => v.verdict === "unmet")) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["traceability", "verdicts"],
        message: `run '${run5.run_id}' traceability phase is 'done' but carries an 'unmet' verdict (unmet must record as failed)`
      });
    }
  }
  if (run5.e2e_phase?.status !== void 0) {
    const isFailed = run5.e2e_phase.status === "failed";
    reasonIffFailed(ctx, {
      runId: run5.run_id,
      path: ["e2e_phase", "reason"],
      label: "e2e phase",
      status: run5.e2e_phase.status,
      reason: run5.e2e_phase.reason
    });
    const hasAdvisory = run5.e2e_phase.advisory != null && run5.e2e_phase.advisory.length > 0;
    if (isFailed && hasAdvisory) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["e2e_phase", "advisory"],
        message: `run '${run5.run_id}' e2e phase is 'failed' but carries an advisory (advisory is the done-side counterpart of reason, never set on failed)`
      });
    }
  }
  if (run5.e2e_assessment?.status !== void 0) {
    reasonIffFailed(ctx, {
      runId: run5.run_id,
      path: ["e2e_assessment", "reason"],
      label: "e2e assessment",
      status: run5.e2e_assessment.status,
      reason: run5.e2e_assessment.reason
    });
  }
  for (const [k, value] of Object.entries(run5.tasks)) {
    if (k !== value.task_id) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["tasks", k, "task_id"],
        message: `tasks map key '${k}' does not match row task_id '${value.task_id}'`
      });
    }
  }
  run5.misses.forEach((e, i) => {
    if (run5.tasks[e.task_id] === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["misses", i, "task_id"],
        message: `miss-ledger references task '${e.task_id}' which is not in run '${run5.run_id}'`
      });
    }
  });
}
var RunStateChecked = RunStateSchema.superRefine(refineRunCrossFields);
function parseRunState(raw) {
  return RunStateChecked.parse(raw);
}

// src/core/state/derive.ts
function mkVerdict(passed, gate, from) {
  return { passed, gate, __derived: true, from };
}
function deriveAllGatesVerdict(evidence) {
  const passed = evidence.length > 0 && evidence.every((e) => e.observed);
  return mkVerdict(passed, "all", [...evidence]);
}

// src/core/state/manager.ts
import { mkdir as mkdir4, readFile as readFile2, readdir, readlink, rename as rename2, rm, symlink, unlink as unlink2 } from "node:fs/promises";
import { existsSync as existsSync4 } from "node:fs";
import { basename as basename3, dirname as dirname3, join as join4 } from "node:path";

// src/core/state/paths.ts
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var SPECS_DIR = "specs";
var SPEC_BUILD_DIR = "spec-build";
var DOCS_FACTORY_DIR = "factory";
var RUNS_DIR = "runs";
var CURRENT_LINK = "current";
var CURRENT_DIR = "current";
var STATE_FILE = "state.json";
function repoKey(repo) {
  const key = repo.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  if (key.length === 0) {
    throw new Error(`repoKey: repo '${repo}' has no usable characters`);
  }
  if (/^\.+$/.test(key)) {
    throw new Error(`repoKey: repo '${repo}' resolves to a path-traversal segment '${key}'`);
  }
  return key;
}
function runsRoot(dataDir) {
  return join3(dataDir, RUNS_DIR);
}
function runDir(dataDir, runId) {
  validateId(runId, "run-id");
  return join3(runsRoot(dataDir), runId);
}
function runStatePath(dataDir, runId) {
  return join3(runDir(dataDir, runId), STATE_FILE);
}
function currentRepoRoot(dataDir) {
  return join3(dataDir, CURRENT_DIR);
}
function currentRepoLinkPath(dataDir, repo) {
  return join3(currentRepoRoot(dataDir), repoKey(repo));
}
function specsRoot(dataDir) {
  return join3(dataDir, SPECS_DIR);
}
function specDir(dataDir, repo, specId) {
  validateId(specId, "spec-id");
  return join3(specsRoot(dataDir), repoKey(repo), specId);
}
function docsFactoryDir(docsRoot, specId) {
  validateId(specId, "spec-id");
  return join3(docsRoot, DOCS_FACTORY_DIR, specId);
}
var SPEC_BUILD_TMP_NAMESPACE = "factory-spec-build";
function defaultSpecBuildRoot() {
  return join3(tmpdir(), SPEC_BUILD_TMP_NAMESPACE);
}
function specBuildRoot(root) {
  return join3(root, SPEC_BUILD_DIR);
}
function specBuildDir(root, repo, issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`specBuildDir: issue number must be a positive integer, got ${issueNumber}`);
  }
  return join3(specBuildRoot(root), repoKey(repo), String(issueNumber));
}

// src/core/state/manager.ts
var log4 = createLogger("state");
var DEFAULT_LOCK_TUNING = DEFAULT_FILE_LOCK_TUNING;
function isStaleStateError(err) {
  return err instanceof JsonParseError || err instanceof ZodError || isUsageError(err);
}
var StateManager = class _StateManager {
  dataDir;
  lockTuning;
  constructor(opts = {}) {
    this.dataDir = resolveDataDir(opts);
    this.lockTuning = { ...DEFAULT_LOCK_TUNING, ...opts.lock ?? {} };
  }
  // ---- paths -------------------------------------------------------------
  statePath(runId) {
    return runStatePath(this.dataDir, runId);
  }
  lockfilePath(runId) {
    return join4(runDir(this.dataDir, runId), "state.lock");
  }
  /**
   * Reject any state file not stamped with the CURRENT schema version, with a clear
   * UsageError instead of a raw ZodError. ABSENT rejects too — every writer stamps
   * the version, so an unstamped file predates the current schema. Ephemeral runs
   * can't be migrated; the remedy is always a fresh run.
   */
  static guardedParse(raw, context) {
    const v = raw?.schema_version;
    if (v !== 3) {
      throw new UsageError(
        `run state at '${context}' uses schema v${JSON.stringify(v)}; only v3 is supported \u2014 this state was created by an older factory version; start a fresh run`
      );
    }
    return parseRunState(raw);
  }
  specLockfilePath(repo, specId) {
    return join4(specDir(this.dataDir, repo, specId), "create.lock");
  }
  // ---- lock --------------------------------------------------------------
  /**
   * Acquire `lockfilePath` (whose parent `dir` must already exist), run `fn`, and
   * always release. `realpath:false` lets us lock a path whose target may be
   * mid-rename or not yet exist (proper-lockfile creates `<path>.lock`).
   * `label` names the resource in the loud not-found + compromised errors.
   */
  async runWithLock(dir, lockfilePath, label, fn) {
    return withFileLock({ dir, lockfile: lockfilePath, label, dirPolicy: "assert", tuning: this.lockTuning }, fn);
  }
  /**
   * Run `fn` while holding the per-run lock. The lockfile's parent (the run dir)
   * must already exist — `create` mkdirs it before first lock; mutators lock an
   * existing run.
   */
  async withLock(runId, fn) {
    return this.runWithLock(runDir(this.dataDir, runId), this.lockfilePath(runId), `run '${runId}'`, fn);
  }
  /**
   * Run `fn` while holding the per-spec lock, keyed by `(repo, specId)`. The
   * durable spec dir is the lock parent — it always exists once the spec is
   * resolved, so this is a stable serialization point for the resolve-or-reuse
   * scan→create critical section (two concurrent same-spec creates can't both
   * observe "no active run" and mint two orphan runs; the per-run clobber guard
   * only protects against a same run_id collision). Distinct lockfile from
   * {@link withLock}, so the nested `create` call inside the body never deadlocks.
   */
  async withSpecLock(repo, specId, fn) {
    return this.runWithLock(
      specDir(this.dataDir, repo, specId),
      this.specLockfilePath(repo, specId),
      `spec '${repo}/${specId}'`,
      fn
    );
  }
  // ---- create ------------------------------------------------------------
  /**
   * Create a brand-new run. Mkdirs the run store layout, writes the initial
   * state.json atomically under the lock, and (best-effort) points the per-repo
   * `current/<repo-key>` pointer at it. Refuses to clobber an existing run dir.
   */
  async create(args) {
    const dir = runDir(this.dataDir, args.run_id);
    if (existsSync4(this.statePath(args.run_id))) {
      throw new Error(`state: run '${args.run_id}' already exists`);
    }
    await mkdir4(join4(dir, "holdouts"), { recursive: true });
    await mkdir4(join4(dir, "reviews"), { recursive: true });
    const now = nowIso();
    const state = parseRunState({
      run_id: args.run_id,
      status: "running",
      execution_mode: args.execution_mode ?? "sequential",
      ship_mode: args.ship_mode ?? "live",
      // Stamp the owning session only when known (best-effort) — an ownerless run
      // is INVISIBLE to the Stop gate (findActiveByOwner never matches it; there is
      // no unscoped fallback), so that session's loop can stop freely.
      ...args.owner_session !== void 0 ? { owner_session: args.owner_session } : {},
      staging_branch: args.staging_branch,
      ...args.ignore_quota !== void 0 ? { ignore_quota: args.ignore_quota } : {},
      ...args.e2e !== void 0 ? { e2e: args.e2e } : {},
      ...args.debug !== void 0 ? { debug: args.debug } : {},
      spec: args.spec,
      tasks: args.tasks ?? {},
      ...args.human_touches !== void 0 ? { human_touches: args.human_touches.map((t) => ({ kind: t.kind, at: t.at ?? now })) } : {},
      started_at: now,
      updated_at: now,
      ended_at: null
    });
    await this.withLock(args.run_id, async () => {
      if (existsSync4(this.statePath(args.run_id))) {
        throw new Error(`state: run '${args.run_id}' already exists`);
      }
      await atomicWriteFile(this.statePath(args.run_id), stringifyJson(state));
    });
    await atomicWriteFile(join4(dir, "audit.jsonl"), "");
    await atomicWriteFile(join4(dir, "metrics.jsonl"), "");
    await this.pointCurrentAt(state);
    return state;
  }
  // ---- read (lock-free) --------------------------------------------------
  /**
   * Read + validate a run's state. LOCK-FREE: the atomic rename on the writer
   * side guarantees a reader sees a whole file. LOUD on a missing run or a
   * schema/JSON violation (never a silent partial).
   */
  async read(runId) {
    const path3 = this.statePath(runId);
    const raw = await readFile2(path3, "utf8");
    return _StateManager.guardedParse(parseJson(raw, path3), path3);
  }
  /**
   * True iff a RunState exists on disk for this run id. Synchronous,
   * no read/parse — mirrors the existence check `create()` already uses
   * internally before writing. Lets a caller distinguish "no run was ever
   * created" from a genuine read failure without parsing.
   */
  exists(runId) {
    return existsSync4(this.statePath(runId));
  }
  /**
   * Read the run the PER-REPO current pointer (`current/<repo-key>`, L2.7) names —
   * the authoritative pointer the human CLI resolves per checkout. A per-repo MISS
   * (no pointer for this repo yet) is simply null — `pointCurrentAt` writes both
   * pointers on every create, so a repo with a run always has its per-repo link.
   * Loud on a corrupt state.json behind the pointer (same contract as readCurrent).
   */
  async readCurrentForRepo(repo) {
    return this.readThroughLink(currentRepoLinkPath(this.dataDir, repo));
  }
  /**
   * Read + validate a run's state THROUGH a `current`-style directory symlink (the
   * OS follows the link during the path walk, so no readlink is needed). Returns
   * null ONLY on genuine ABSENCE (missing/dangling link → ENOENT); a corrupt/invalid
   * state.json propagates LOUDLY (swallowing it would make a corrupt active run
   * indistinguishable from "no current run"). Shared by {@link readCurrent} and
   * {@link readCurrentForRepo}.
   */
  async readThroughLink(link) {
    if (!existsSync4(link)) {
      return null;
    }
    const statePath = join4(link, "state.json");
    let raw;
    try {
      raw = await readFile2(statePath, "utf8");
    } catch (err) {
      if (isEnoent(err)) {
        return null;
      }
      throw err;
    }
    return _StateManager.guardedParse(parseJson(raw, statePath), statePath);
  }
  // ---- enumerate (lock-free) ---------------------------------------------
  /**
   * Enumerate every run in the store, newest-first (run-id descending — the id is
   * lexicographically chronological). Each run dir's state.json is read + validated
   * through {@link read}. Non-directory entries (the `runs/current` symlink and any
   * `*.tmp.<pid>` link create() leaves behind) are excluded. A run dir without a
   * state.json (mid-creation, or cleaned) is skipped silently; one whose state.json
   * is unreadable/corrupt/invalid is skipped with a LOUD warning — a single corrupt
   * historical run must not brick `run create`'s resolve-or-reuse scan. (Targeted
   * {@link read} keeps its loud-on-corruption contract; only this bulk scan tolerates
   * a bad entry, and never silently.)
   */
  /**
   * Readdir the runs root, tolerating a missing root (no runs yet → []) and
   * filtering to directories (excludes the `current` + temp symlinks). The shared
   * prologue of {@link listRuns} and {@link listStaleRunDirs}.
   */
  async runDirEntries() {
    try {
      const entries = await readdir(runsRoot(this.dataDir), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if (isEnoent(err)) {
        return [];
      }
      throw err;
    }
  }
  async listRuns() {
    const runs = [];
    for (const name of await this.runDirEntries()) {
      try {
        runs.push(await this.read(name));
      } catch (err) {
        if (isEnoent(err)) {
          continue;
        }
        log4.warn(`state: skipping unreadable run '${name}': ${err.message}`);
      }
    }
    return runs.sort((a, b) => b.run_id.localeCompare(a.run_id));
  }
  /**
   * Enumerate the run dirs THIS engine cannot parse (D57) — the population
   * {@link listRuns} warn-skips: an old-schema stamp (`schema_version !== 3`) or
   * corrupt JSON. These are `rescue gc` sweep candidates; a stale pointer at one
   * of them is what crashed `run create` in the 2026-07-07 incident. Best-effort
   * raw field extraction (`staging_branch`, `spec.repo`) enables the GitHub-side
   * teardown; a structurally-invalid v3 state is NOT stale (current-engine
   * wreckage — surfaces loudly through targeted reads, never swept here).
   */
  async listStaleRunDirs() {
    const stale = [];
    for (const name of await this.runDirEntries()) {
      let raw;
      try {
        raw = await readFile2(runStatePath(this.dataDir, name), "utf8");
      } catch (err) {
        if (isEnoent(err)) {
          continue;
        }
        throw err;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        stale.push({ run_id: name, reason: "corrupt-json" });
        continue;
      }
      const obj = parsed;
      const v = obj?.schema_version;
      if (v === 3) {
        continue;
      }
      const branch = obj?.staging_branch;
      const repo = obj?.spec?.repo;
      stale.push({
        run_id: name,
        reason: `schema-v${JSON.stringify(v)}`,
        ...typeof branch === "string" && branch.length > 0 ? { staging_branch: branch } : {},
        ...typeof repo === "string" && repo.length > 0 ? { repo } : {}
      });
    }
    return stale.sort((a, b) => b.run_id.localeCompare(a.run_id));
  }
  /**
   * Delete a run dir outright and drop any `current` pointer naming it (D57) —
   * `rescue gc --apply`'s stale-run sweep. NOT a lifecycle verb: live runs are
   * cancelled/superseded through state, never deleted; this exists solely for
   * wreckage {@link read} cannot even parse, so it takes no lock (there is no
   * valid state to serialize against).
   */
  async deleteRun(runId) {
    await rm(runDir(this.dataDir, runId), { recursive: true, force: true });
    const links = [];
    try {
      const repoLinks = await readdir(currentRepoRoot(this.dataDir), { withFileTypes: true });
      links.push(...repoLinks.map((e) => join4(currentRepoRoot(this.dataDir), e.name)));
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
    }
    for (const link of links) {
      let target;
      try {
        target = await readlink(link);
      } catch {
        continue;
      }
      if (basename3(target) === runId) {
        await rm(link, { force: true }).catch(() => {
        });
      }
    }
  }
  /**
   * Find the single NON-terminal run for `(repo, issueNumber)`, or null. Powers the
   * resolve-or-reuse path of `run create`: a repeated create returns the live run
   * instead of spawning an orphan. Matches by the STABLE issue number, not the exact
   * `spec_id` — a spec id is `<issue>-<slug>` where the slug is agent-named and can
   * drift across regenerations, and one issue means at most one active run: the
   * supersede teardown, the weekly-quota wall, and the no-silent-reuse prompt must
   * all see a drifted-slug run.
   *
   * @throws when ≥2 active runs match — a state defect (duplicates have occurred in
   *         the wild); silently picking one could tear down or reuse the wrong run.
   *         Fail loud and let `/factory:resume` repair.
   */
  async findActiveByIssue(repo, issueNumber) {
    const runs = await this.listRuns();
    const matches = runs.filter(
      (r) => r.spec.repo === repo && r.spec.issue_number === issueNumber && !isTerminalRunStatus(r.status)
    );
    if (matches.length > 1) {
      throw new Error(
        `findActiveByIssue: ${matches.length} active runs for issue #${issueNumber} in ${repo} (${matches.map((r) => r.run_id).join(", ")}) \u2014 one issue must have at most one active run; repair with /factory:resume`
      );
    }
    return matches.length === 1 ? at(matches, 0) : null;
  }
  /**
   * TRUE when another NON-terminal run (any issue) exists for `repo` besides
   * `excludeRunId`. Active-run uniqueness is per (repo, issue) — two PRDs can
   * have simultaneously active runs on one repo — so the D74 de-escalation
   * sites (finalize / supersede / cancel `--cleanup`) and scaffold's
   * `--provision` must not drop develop to baseline while a sibling run still
   * relies on the strict profile.
   */
  async hasOtherActiveForRepo(repo, excludeRunId) {
    const runs = await this.listRuns();
    return runs.some((r) => r.spec.repo === repo && r.run_id !== excludeRunId && !isTerminalRunStatus(r.status));
  }
  /**
   * ALL non-terminal runs owned by `session` (its `owner_session`), newest-first
   * (empty session → `[]`). The raw list behind {@link findActiveByOwner}: callers
   * that must DISTINGUISH "none owned" from "ambiguous (≥2 owned)" — e.g. `run cancel`,
   * which fails LOUD on ambiguity rather than guessing which run to abandon — branch
   * on `.length`.
   */
  async findAllActiveByOwner(session) {
    if (session.length === 0) {
      return [];
    }
    const runs = await this.listRuns();
    return runs.filter((r) => r.owner_session === session && !isTerminalRunStatus(r.status));
  }
  /**
   * Find the SINGLE non-terminal run owned by `session` (its `owner_session`), or
   * null. Powers the session-scoped Bash guards (run-isolation L1.3): a guard fires
   * only for the run the stopping/acting session actually owns, never a concurrent
   * run in another repo. An empty session, no match, or ≥2 matches (ambiguous — one
   * session minting runs in two repos) all return null, so the caller fails SAFE
   * (passes through) rather than gating the wrong run. Callers that must tell "none"
   * from "ambiguous" apart use {@link findAllActiveByOwner} and branch on its length.
   */
  async findActiveByOwner(session) {
    const owned = await this.findAllActiveByOwner(session);
    return owned.length === 1 ? at(owned, 0) : null;
  }
  // ---- update (locked read-modify-write) ---------------------------------
  /**
   * Atomically mutate a run under the lock. `mutator` receives the current state
   * and returns the next state; the result is re-validated through the schema
   * (so a mutator cannot persist an out-of-enum value) and `updated_at` is
   * stamped. This is the ONLY write path for an existing run.
   */
  async update(runId, mutator) {
    return this.withLock(runId, async () => {
      const current = await this.read(runId);
      const next = await mutator(current);
      if (next.run_id !== runId) {
        throw new Error(
          `state: update mutator changed run_id ('${runId}' \u2192 '${next.run_id}') \u2014 identity is immutable`
        );
      }
      if (next.spec.repo !== current.spec.repo || next.spec.spec_id !== current.spec.spec_id || next.spec.issue_number !== current.spec.issue_number) {
        throw new Error(
          `state: update mutator changed the spec pointer for run '${runId}' \u2014 identity is immutable`
        );
      }
      const validated = parseRunState({
        ...next,
        updated_at: nowIso()
      });
      await atomicWriteFile(this.statePath(runId), stringifyJson(validated));
      return validated;
    });
  }
  /**
   * Convenience: mutate a single task in place. Throws if the task is absent
   * (a typo'd task id is a loud error, not a silent create).
   */
  async updateTask(runId, taskId, mutator) {
    return this.update(runId, (state) => {
      const task = state.tasks[taskId];
      if (!task) {
        throw new Error(`state: run '${runId}' has no task '${taskId}'`);
      }
      return { ...state, tasks: { ...state.tasks, [taskId]: mutator(task) } };
    });
  }
  async finalize(runId, status, reason) {
    if (!isTerminalRunStatus(status)) {
      throw new Error(`state: finalize requires a terminal status (completed|failed|superseded); got '${status}'`);
    }
    if (status === "completed" && reason !== void 0) {
      throw new Error(`state: finalize 'completed' takes no reason; got '${reason}'`);
    }
    if (status !== "completed" && (reason === void 0 || reason.trim().length === 0)) {
      throw new Error(`state: finalize '${status}' requires a non-empty reason`);
    }
    return this.update(runId, (state) => {
      if (isTerminalRunStatus(state.status) && state.status !== status) {
        throw new Error(
          `state: run '${runId}' already terminal as '${state.status}'; cannot re-finalize as '${status}'`
        );
      }
      if (isTerminalRunStatus(state.status) && state.terminal_reason !== void 0 && reason !== void 0 && state.terminal_reason !== reason) {
        throw new Error(
          `state: run '${runId}' already finalized '${status}' with reason '${state.terminal_reason}'; refusing to replace it with '${reason}'`
        );
      }
      return {
        ...state,
        status,
        quota: void 0,
        terminal_reason: state.terminal_reason ?? reason,
        ended_at: state.ended_at ?? nowIso()
      };
    });
  }
  // ---- current symlink ---------------------------------------------------
  /**
   * Repoint the PER-REPO current pointer `current/<repo-key>` → `../runs/<run-id>`
   * at a freshly-created run (L2.6/L2.7) — the single live pointer, authoritative
   * for the human CLI per checkout. The legacy GLOBAL `runs/current` link is
   * RETIRED (Decision 61): nothing reads it; this method only best-effort rms a
   * leftover from an older engine.
   *
   * CLOBBER GUARD (L2.6) — runs BEFORE any write and throws LOUD (NOT swallowed by the
   * best-effort symlink catch below): if THIS repo's current pointer already names a
   * still-live run owned by a DIFFERENT known session, refuse to hide it. Same-repo
   * concurrent runs by distinct sessions are thus serialized, while cross-repo creates
   * (a different repo's pointer) never trip it. The just-created run's `state.json`
   * already exists, so it stays addressable via `--run <id>` after the throw.
   * Degrades safe (no refusal) when either owner is unknown — today's last-wins behavior.
   *
   * POINTER-LIVENESS TOLERANCE (D57): an UNPARSEABLE pointer target (old-schema,
   * corrupt JSON) classifies as STALE — warn loudly and repoint. A run this engine
   * cannot parse cannot be owned by a live session of this engine, so it can never
   * prove the "still-live, different owner" condition the guard exists for. Mirrors
   * {@link listRuns}' tolerate-loudly precedent; readCurrentForRepo keeps its loud
   * contract for every other caller.
   *
   * The tolerance is SCOPED to recognized parse/schema failures ({@link isStaleStateError}
   * — JSON parse errors, the schema-version UsageError, or a Zod validation error);
   * any other error (EACCES, EIO, or an unexpected bug) rethrows loudly instead of
   * being treated as stale, so a transient read failure on a genuinely live,
   * different-owner run never silently repoints over it.
   */
  async pointCurrentAt(state) {
    const repo = state.spec.repo;
    let existing;
    try {
      existing = await this.readCurrentForRepo(repo);
    } catch (err) {
      if (!isStaleStateError(err)) {
        throw err;
      }
      log4.warn(
        `state: current pointer for repo '${repo}' names an unparseable run \u2014 treating as stale and repointing: ${err.message}`
      );
      existing = null;
    }
    if (existing !== null && existing.run_id !== state.run_id && !isTerminalRunStatus(existing.status) && existing.owner_session !== void 0 && state.owner_session !== void 0 && existing.owner_session !== state.owner_session) {
      throw new Error(
        `state: refusing to repoint current for repo '${repo}' \u2014 run '${existing.run_id}' is still live (owned by a different session '${existing.owner_session}'). Run '${state.run_id}' was created and is addressable via \`--run ${state.run_id}\`; finalize or rescue '${existing.run_id}' before starting a concurrent run in this repo.`
      );
    }
    await this.repointSymlink(currentRepoLinkPath(this.dataDir, repo), join4("..", RUNS_DIR, state.run_id));
    await rm(join4(runsRoot(this.dataDir), CURRENT_LINK), { force: true }).catch(() => {
    });
  }
  /**
   * Atomically-ish repoint a `current`-style symlink at `target` (write a temp link
   * then rename). Best-effort: a failure is logged, not fatal — `current` is a
   * convenience pointer, not load-bearing state.
   */
  async repointSymlink(link, target) {
    const tmp = `${link}.tmp.${process.pid}`;
    try {
      await mkdir4(dirname3(link), { recursive: true });
      await unlink2(tmp).catch(() => {
      });
      await symlink(target, tmp);
      await rm(link, { force: true, recursive: false }).catch(() => {
      });
      await rename2(tmp, link);
    } catch (err) {
      log4.warn(`state: could not update current pointer '${link}' \u2192 '${target}': ${err.message}`);
      await unlink2(tmp).catch(() => {
      });
    }
  }
};

// src/cli/args.ts
function parseArgs(argv, opts = {}) {
  const booleans = /* @__PURE__ */ new Set(["help", "h", ...opts.booleans ?? []]);
  const positionals = [];
  const values = /* @__PURE__ */ new Map();
  const push = (name, value) => {
    if (opts.allowed !== void 0 && !["help", "h", ...opts.allowed].includes(name)) {
      throw new UsageError(`unsupported --${name}`);
    }
    const list = values.get(name) ?? [];
    list.push(value);
    values.set(name, list);
  };
  let i = 0;
  let optionsEnded = false;
  while (i < argv.length) {
    const tok = at(argv, i);
    if (optionsEnded || !tok.startsWith("-")) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    if (tok === "--") {
      optionsEnded = true;
      i += 1;
      continue;
    }
    const dashless = tok.replace(/^-+/, "");
    const eq = dashless.indexOf("=");
    if (eq >= 0) {
      push(dashless.slice(0, eq), dashless.slice(eq + 1));
      i += 1;
      continue;
    }
    if (booleans.has(dashless)) {
      push(dashless, true);
      i += 1;
      continue;
    }
    const next = argv[i + 1];
    if (next === void 0 || next.startsWith("-") && next !== "-") {
      push(dashless, true);
      i += 1;
    } else {
      push(dashless, next);
      i += 2;
    }
  }
  const lastOf = (name) => {
    const list = values.get(name);
    return list === void 0 ? void 0 : list[list.length - 1];
  };
  return {
    positionals,
    flag: lastOf,
    all: (name) => (values.get(name) ?? []).map(String),
    has: (name) => values.has(name),
    requireFlag(name) {
      const v = lastOf(name);
      if (typeof v !== "string" || v.length === 0) {
        throw new UsageError(`missing required --${name}`);
      }
      return v;
    }
  };
}
function optionalString(raw) {
  return typeof raw === "string" && raw.length > 0 ? raw : void 0;
}

// src/cli/io.ts
function emitJson(value) {
  process.stdout.write(stringifyJson(value) + "\n");
}
function emitLine(line) {
  process.stdout.write(line + "\n");
}
function emitHelp(text) {
  emitLine(text);
  return EXIT.OK;
}
function emitError(line) {
  process.stderr.write(line + "\n");
}

// src/cli/registry-types.ts
function withUsageGuard(prefix, fn) {
  return async (argv) => {
    try {
      return await fn(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`${prefix}: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  };
}

// src/cli/subcommands/configure.ts
var HELP = `factory configure \u2014 inspect or edit the config overlay

Usage:
  factory configure                         Print the resolved config as JSON
  factory configure --get <key.path>        Print one resolved value as JSON
  factory configure --set <key.path=value>  Set a value (repeatable), persist, print result
  factory configure --unset <key.path>      Revert a key to its default (repeatable)

Values parse as JSON when possible (numbers, booleans, arrays); otherwise as a
bare string. Examples:
  factory configure --set quality.holdoutPercent=25
  factory configure --set git.baseBranch=develop
  factory configure --set git.autoProvision=true`;
async function run(argv) {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    return emitHelp(HELP);
  }
  const sets = args.all("set");
  const unsets = args.all("unset");
  const getKey = args.flag("get");
  if (typeof getKey === "string") {
    if (sets.length > 0 || unsets.length > 0) {
      throw new UsageError("--get cannot be combined with --set/--unset");
    }
    emitJson(getAtPath(loadConfig(), splitPath(getKey)));
    return EXIT.OK;
  }
  if (sets.length === 0 && unsets.length === 0) {
    emitJson(loadConfig());
    return EXIT.OK;
  }
  let raw = readRawConfig();
  for (const token of sets) {
    const { path: path3, value } = parseSetToken(token);
    raw = setAtPath(raw, path3, value);
  }
  for (const token of unsets) {
    raw = unsetAtPath(raw, splitPath(token));
  }
  const resolved = await saveRawConfig(raw);
  emitJson(resolved);
  return EXIT.OK;
}
var configureCommand = {
  describe: "Inspect or edit the persisted config (--get/--set/--unset)",
  run: withUsageGuard("configure", run)
};

// src/cli/subcommands/scaffold.ts
import { mkdir as mkdir8, readFile as readFile7, rm as rm2, unlink as unlink3, writeFile as writeFile3 } from "node:fs/promises";
import { existsSync as existsSync8 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname7, join as join9, relative } from "node:path";
import { fileURLToPath } from "node:url";

// src/git/run-staging.ts
var FALLBACK_STAGING_BRANCH = "staging";

// src/verifier/deterministic/gate-contract.ts
import { readFile as readFile3 } from "node:fs/promises";
import { join as join5 } from "node:path";

// src/shared/command-allowlist.ts
var SAFE_TOKEN = /^[A-Za-z0-9._/=:+-]+$/;
function runnerName(argv) {
  const bin = argv[0] ?? "";
  return bin.includes("/") ? bin.slice(bin.lastIndexOf("/") + 1) : bin;
}
function validateCommand(command, isAllowedRunner) {
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  for (const t of tokens) {
    if (!SAFE_TOKEN.test(t)) {
      return { ok: false, reason: "unsafe_command", detail: `unsafe token '${t}'` };
    }
  }
  if (tokens[0] === void 0) {
    return { ok: false, reason: "unsafe_command", detail: "empty command" };
  }
  if (!isAllowedRunner(tokens)) {
    return {
      ok: false,
      reason: "unallowed_runner",
      detail: `runner '${runnerName(tokens)}' not allowlisted`
    };
  }
  return { ok: true, argv: tokens };
}

// src/verifier/deterministic/gate-id.ts
var GATE_IDS = [
  "test",
  "tdd",
  "coverage",
  "mutation",
  "sast",
  "type",
  "lint",
  "build"
];

// src/verifier/deterministic/gate-contract.ts
var log5 = createLogger("gate-contract");
var GATE_CONTRACT_REL = ".factory/gates.json";
var MUTATION_CHECK_CONTEXT = "Mutation Testing";
var GATE_CONTRACT_STACKS = ["npm", "deno", "custom"];
var COMMAND_GATES = ["test", "type", "build", "lint", "coverage"];
function isAllowedGateRunner(argv) {
  const runner = runnerName(argv);
  const a1 = argv[1];
  switch (runner) {
    case "deno":
      return a1 === "test" || a1 === "check" || a1 === "task" || a1 === "lint" || a1 === "fmt";
    case "go":
      return a1 === "test";
    case "cargo":
      return a1 === "test" || a1 === "check" || a1 === "build";
    case "npm":
    case "pnpm":
    case "yarn":
      return a1 === "run" && argv[2] !== void 0;
    case "vitest":
    case "tsc":
    case "eslint":
    case "jest":
    case "mocha":
    case "pytest":
      return true;
    default:
      return false;
  }
}
function validateGateCommand(command) {
  return validateCommand(command, isAllowedGateRunner);
}
var MUTATION_DEFAULT_ROOTS = ["src"];
var ROOT_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
var RootsSchema = external_exports.array(
  external_exports.string().refine((r) => r.split("/").every((seg) => ROOT_SEGMENT_RE.test(seg)), {
    message: "mutation root must be a plain repo-relative directory path (no globs, no leading /)"
  }).refine((r) => r.split("/").every((seg) => seg !== ".." && seg !== "."), {
    message: "mutation root must not contain '.' or '..' segments"
  })
).nonempty("mutation roots must name at least one directory");
var ContractedSchema = external_exports.object({
  contracted: external_exports.literal(true),
  /** Stack-specific command override; validated + only on {@link COMMAND_GATES}. */
  command: external_exports.string().optional(),
  /** Mutable-source roots (mutation gate ONLY); defaults to {@link MUTATION_DEFAULT_ROOTS}. */
  roots: RootsSchema.optional()
}).strict();
var UncontractedSchema = external_exports.object({
  contracted: external_exports.literal(false),
  /** Why this gate is waived — required; the committed audit trail. */
  reason: external_exports.string().min(1, "uncontracted gate requires a non-empty reason")
}).strict();
var EntrySchema = external_exports.discriminatedUnion("contracted", [ContractedSchema, UncontractedSchema]);
var SetupStepSchema = external_exports.object({
  name: external_exports.string().min(1).optional(),
  uses: external_exports.string().min(1).optional(),
  with: external_exports.record(external_exports.string()).optional(),
  run: external_exports.string().min(1).optional()
}).strict().superRefine((step, issues) => {
  if (step.uses === void 0 === (step.run === void 0)) {
    issues.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "setup step requires exactly one of 'uses' or 'run'"
    });
  }
  if (step.with !== void 0 && step.uses === void 0) {
    issues.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: "'with' is only allowed on a 'uses' step"
    });
  }
});
var GateContractSchema = external_exports.object({
  version: external_exports.literal(1),
  stack: external_exports.enum(GATE_CONTRACT_STACKS),
  gates: external_exports.object(Object.fromEntries(GATE_IDS.map((id) => [id, EntrySchema]))).strict(),
  /** CI env-boot steps rendered into the managed workflow (Decision 73). */
  setup_steps: external_exports.array(SetupStepSchema).optional(),
  /**
   * Extra required CI contexts for this repo's develop branch, merged into
   * BOTH protection profiles (run + baseline) — additive-only per-repo
   * required checks (e.g. outsidey's `pgTAP`). `'Mutation Testing'` is
   * rejected here — it has its own switch below.
   */
  requiredChecks: external_exports.array(external_exports.string().min(1, "requiredChecks entries must be non-empty")).refine((cs) => !cs.includes(MUTATION_CHECK_CONTEXT), {
    message: `'${MUTATION_CHECK_CONTEXT}' is managed by the profiles \u2014 use requireMutationAtRest instead`
  }).optional(),
  /**
   * Keep `'Mutation Testing'` required on develop's BASELINE profile too
   * (at rest, between runs) instead of the default run-profile-only.
   */
  requireMutationAtRest: external_exports.boolean().optional()
}).strict().superRefine((contract, issues) => {
  for (const id of GATE_IDS) {
    const entry = contract.gates[id];
    if (entry.contracted && entry.roots !== void 0 && id !== "mutation") {
      issues.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["gates", id, "roots"],
        message: `gate '${id}' does not use mutable-source roots (allowed on: mutation)`
      });
    }
    if (!entry.contracted || entry.command === void 0) {
      continue;
    }
    if (!COMMAND_GATES.includes(id)) {
      issues.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["gates", id, "command"],
        message: `gate '${id}' does not execute a command override (allowed on: ${COMMAND_GATES.join(", ")})`
      });
      continue;
    }
    const v = validateGateCommand(entry.command);
    if (!v.ok) {
      issues.addIssue({
        code: external_exports.ZodIssueCode.custom,
        path: ["gates", id, "command"],
        message: `${v.reason}: ${v.detail}`
      });
    }
  }
});
async function loadGateContract(rootAbs) {
  let raw;
  try {
    raw = await readFile3(join5(rootAbs, GATE_CONTRACT_REL), "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return { state: "absent" };
    }
    return { state: "invalid", error: `unreadable: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: "invalid", error: `not JSON: ${err.message}` };
  }
  const result = GateContractSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { state: "invalid", error: issues };
  }
  return { state: "ok", contract: result.data };
}
var SCOPE_SKIP_REASONS = /* @__PURE__ */ new Set(["no-vitest-runnable-tests-in-scope", "no-mutable-changes"]);
function classifySkip(reason) {
  return SCOPE_SKIP_REASONS.has(reason) ? "scope" : "tooling";
}
function mutationRoots(contract) {
  const entry = contract?.gates.mutation;
  if (entry !== void 0 && entry.contracted && entry.roots !== void 0) {
    return entry.roots;
  }
  return MUTATION_DEFAULT_ROOTS;
}
function requiredCheckExtras(contract) {
  return {
    requiredChecks: contract?.requiredChecks ?? [],
    requireMutationAtRest: contract?.requireMutationAtRest ?? false
  };
}
function contractCommand(contract, id) {
  const entry = contract?.gates[id];
  if (entry === void 0 || !entry.contracted || entry.command === void 0) {
    return void 0;
  }
  const v = validateGateCommand(entry.command);
  if (!v.ok) {
    throw new Error(`gate contract: gate '${id}' command invalid (${v.reason}: ${v.detail})`);
  }
  return v.argv;
}

// src/git/protection.ts
var log6 = createLogger("git");
function effectiveProfiles(git, extras) {
  const union = (...lists) => [...new Set(lists.flat())];
  const run5 = union(git.developRequiredStatusChecks, extras.requiredChecks);
  const atRest = extras.requireMutationAtRest && run5.includes(MUTATION_CHECK_CONTEXT) ? [MUTATION_CHECK_CONTEXT] : [];
  return { run: run5, baseline: union(git.developBaselineStatusChecks, extras.requiredChecks, atRest) };
}
var ProtectionMissingError = class extends Error {
  branch;
  reasons;
  constructor(branch, reasons) {
    super(
      `branch protection on '${branch}' is insufficient \u2014 run refuses to start:
  - ${reasons.join(
        "\n  - "
      )}
Re-run with --provision to provision protection, or configure it manually.`
    );
    this.name = "ProtectionMissingError";
    this.branch = branch;
    this.reasons = reasons;
  }
};
async function probeProtection(args) {
  const branch = args.branch ?? FALLBACK_STAGING_BRANCH;
  const result = await args.ghClient.repoProtection(args.owner, args.repo, branch);
  return {
    enabled: result.enabled,
    requiredStatusChecks: result.requiredStatusChecks,
    strictUpToDate: result.strictUpToDate,
    hasMergeQueue: result.hasMergeQueue
  };
}
function requireProtectionOrRefuse(state, requiredChecks, branch = FALLBACK_STAGING_BRANCH, opts = {}) {
  const reasons = [];
  if (!state.enabled) {
    reasons.push("no branch protection is configured");
  }
  if (!state.strictUpToDate && (opts.requireStrict ?? true)) {
    reasons.push("required_status_checks.strict (branches up-to-date) is OFF");
  }
  for (const check of requiredChecks) {
    if (!state.requiredStatusChecks.includes(check)) {
      reasons.push(`required status check '${check}' is not enforced`);
    }
  }
  if (reasons.length > 0) {
    throw new ProtectionMissingError(branch, reasons);
  }
  return state;
}
async function provisionProtection(args) {
  const branch = args.branch ?? FALLBACK_STAGING_BRANCH;
  if (!args.provision) {
    throw new Error("provisionProtection called without --provision opt-in \u2014 refusing to mutate branch protection");
  }
  log6.info(`--provision: writing branch protection for ${args.owner}/${args.repo}@${branch}`);
  await args.ghClient.putProtection(args.owner, args.repo, branch, {
    requiredStatusChecks: [...args.requiredChecks],
    strict: true
  });
  return probeProtection({
    ghClient: args.ghClient,
    owner: args.owner,
    repo: args.repo,
    branch
  });
}
async function provisionStableProtection(args) {
  if (!args.provision) {
    throw new Error("stable protection changes require --provision");
  }
  const branch = args.branch ?? FALLBACK_STAGING_BRANCH;
  const state = await probeProtection({ ...args, branch });
  if (!state.enabled) {
    return provisionProtection(args);
  }
  if (state.strictUpToDate && args.requiredChecks.every((check) => state.requiredStatusChecks.includes(check))) {
    return state;
  }
  if (!args.ghClient.strengthenStatusChecks) {
    throw new Error("client cannot preserve existing branch policy; configure required status checks manually");
  }
  await args.ghClient.strengthenStatusChecks(args.owner, args.repo, branch, args.requiredChecks);
  return probeProtection({ ...args, branch });
}

// src/shared/gate-config-names.ts
var STRYKER_CONFIG_BASENAMES = [
  "stryker.conf.json",
  "stryker.conf.js",
  "stryker.conf.mjs",
  "stryker.conf.cjs",
  "stryker.config.json",
  "stryker.config.js",
  "stryker.config.mjs",
  "stryker.config.cjs",
  ".stryker.conf.json",
  ".stryker.conf.js",
  ".stryker.conf.mjs",
  ".stryker.conf.cjs",
  ".stryker.config.json",
  ".stryker.config.js",
  ".stryker.config.mjs",
  ".stryker.config.cjs"
];

// src/git/exec-tools.ts
function makeRunner(command) {
  return (args, opts) => exec(command, args, opts);
}
var defaultGitRunner = makeRunner("git");
var defaultGhRunner = makeRunner("gh");
async function runOrThrow(command, runner, args, opts) {
  const result = await runner(args, opts);
  if (result.code !== 0) {
    throw new ExecError(command, args, result);
  }
  return result;
}

// src/git/git-client.ts
import { dirname as dirname4 } from "node:path";
var log7 = createLogger("git");
var DefaultGitClient = class {
  runner;
  constructor(runner = defaultGitRunner) {
    this.runner = runner;
  }
  toExecOpts(opts) {
    return opts?.cwd != null && opts.cwd.length > 0 ? { cwd: opts.cwd } : {};
  }
  exec(args, opts) {
    return this.runner(args, this.toExecOpts(opts));
  }
  execOrThrow(args, opts) {
    return runOrThrow("git", this.runner, args, this.toExecOpts(opts));
  }
  async fetch(remote, ref, opts) {
    await this.execOrThrow(["fetch", remote, ref], opts);
  }
  async revParse(ref, opts) {
    const r = await this.execOrThrow(["rev-parse", ref], opts);
    return r.stdout.trim();
  }
  async branchExists(ref, opts) {
    const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
    const r = await this.exec(["show-ref", "--verify", "--quiet", fullRef], opts);
    if (r.code === 0) {
      return true;
    }
    if (r.code === 1) {
      return false;
    }
    throw new Error(`git show-ref failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
  }
  async refExists(ref, opts) {
    const r = await this.exec(["rev-parse", "--verify", "--quiet", ref], opts);
    if (r.code === 0) {
      return true;
    }
    if (r.code === 1) {
      return false;
    }
    throw new Error(`git rev-parse failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
  }
  async isTracked(relPath, opts) {
    const r = await this.exec(["ls-files", "--error-unmatch", "--", relPath], opts);
    if (r.code === 0) {
      return true;
    }
    if (r.code === 1) {
      return false;
    }
    throw new Error(`git ls-files failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
  }
  async commitsAhead(base, branch, opts) {
    const r = await this.execOrThrow(["rev-list", "--count", `${base}..${branch}`], opts);
    const n = Number.parseInt(r.stdout.trim(), 10);
    if (!Number.isFinite(n)) {
      throw new Error(`git rev-list --count returned non-numeric output: ${JSON.stringify(r.stdout)}`);
    }
    return n;
  }
  async checkoutB(branch, startPoint, opts) {
    log7.debug(`checkout -B ${branch} ${startPoint}`);
    await this.execOrThrow(["checkout", "-B", branch, startPoint], opts);
  }
  async currentBranch(opts) {
    const r = await this.execOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], opts);
    return r.stdout.trim();
  }
  async showToplevel(opts) {
    const r = await this.execOrThrow(["rev-parse", "--show-toplevel"], opts);
    return r.stdout.trim();
  }
  async mainWorktreeRoot(opts) {
    const r = await this.execOrThrow(["rev-parse", "--path-format=absolute", "--git-common-dir"], opts);
    return dirname4(r.stdout.trim());
  }
  async remoteUrl(remote, opts) {
    const r = await this.exec(["remote", "get-url", remote], opts);
    if (r.code !== 0) {
      return null;
    }
    const url = r.stdout.trim();
    return url.length > 0 ? url : null;
  }
  async lsRemoteHeads(remote, branch, opts) {
    const r = await this.execOrThrow(["ls-remote", "--heads", remote, branch], opts);
    const line = r.stdout.trim();
    if (line.length === 0) {
      return null;
    }
    const sha = line.split(/\s+/)[0];
    return sha != null && sha.length > 0 ? sha : null;
  }
  async mergeBase(a, b, opts) {
    const r = await this.execOrThrow(["merge-base", a, b], opts);
    return r.stdout.trim();
  }
  async worktreeAdd(args, opts) {
    await this.execOrThrow(["worktree", "add", ...args], opts);
  }
  async worktreeExists(path3, opts) {
    const r = await this.execOrThrow(["worktree", "list", "--porcelain"], opts);
    return r.stdout.split("\n").some((line) => line === `worktree ${path3}`);
  }
  async worktreeRemove(args, opts) {
    const r = await this.exec(["worktree", "remove", ...args], opts);
    return r.code;
  }
  async push(remote, branch, opts) {
    const args = ["push"];
    if (opts?.setUpstream === true) {
      args.push("-u");
    }
    args.push(remote, branch);
    await this.execOrThrow(args, opts);
  }
  async mergeFfOrCommit(branch, ref, opts) {
    log7.debug(`merge --no-edit ${ref} into ${branch}`);
    await this.execOrThrow(["checkout", branch], opts);
    await this.execOrThrow(["merge", "--no-edit", ref], opts);
  }
  async tryMergeNoForce(branch, ref, opts) {
    const mergeArgs = opts?.message !== void 0 ? ["merge", "-m", opts.message, ref] : ["merge", "--no-edit", ref];
    log7.debug(`tryMerge ${mergeArgs.slice(1).join(" ")} into ${branch}`);
    await this.execOrThrow(["checkout", branch], opts);
    const r = await this.exec(mergeArgs, opts);
    if (r.code === 0) {
      return { merged: true };
    }
    const conflict = (r.stderr.trim().length > 0 ? r.stderr : r.stdout).trim() || `git merge exited ${r.code ?? "null"}`;
    await this.exec(["merge", "--abort"], opts);
    return { merged: false, conflict };
  }
  async resetHardClean(ref, opts) {
    log7.debug(`reset --hard ${ref} && clean -fd`);
    await this.execOrThrow(["reset", "--hard", ref], opts);
    await this.execOrThrow(["clean", "-fd"], opts);
  }
  async diffNames(base, ref, opts) {
    const r = await this.execOrThrow(["diff", "--name-only", `${base}...${ref}`], opts);
    return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  }
};

// src/git/repo.ts
function parseRemoteUrl(url) {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let path3;
  const scp = /^[^/@]+@[^/:]+:(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    path3 = scp[1];
  } else {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/.exec(trimmed);
    if (withScheme) {
      const afterScheme = nonNull(withScheme[1]);
      const firstSlash = afterScheme.indexOf("/");
      if (firstSlash >= 0) {
        path3 = afterScheme.slice(firstSlash + 1);
      }
    }
  }
  if (path3 === void 0) {
    return null;
  }
  let p = path3.replace(/\/+$/, "");
  p = p.replace(/\.git$/i, "");
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    return null;
  }
  const name = at(segments, segments.length - 1);
  const owner = at(segments, segments.length - 2);
  if (owner.length === 0 || name.length === 0) {
    return null;
  }
  return `${owner}/${name}`;
}
var REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
function isValidRepoSlug(slug) {
  const parts = slug.split("/");
  return parts.length === 2 && parts.every((seg) => REPO_SEGMENT.test(seg) && seg !== "." && seg !== "..");
}
function validateRepoSlug(slug) {
  if (!isValidRepoSlug(slug)) {
    throw new UsageError(
      `--repo must be '<owner>/<name>' where each part is [A-Za-z0-9._-] and not '.'/'..' (no slashes, spaces, or other characters), got '${slug}'`
    );
  }
  return slug;
}
function splitRepoSlug(slug) {
  const parts = validateRepoSlug(slug).split("/");
  return { owner: at(parts, 0), repo: at(parts, 1) };
}
async function resolveRepo(args) {
  const remote = args.remote ?? "origin";
  const explicit = typeof args.explicit === "string" && args.explicit.length > 0 ? validateRepoSlug(args.explicit) : void 0;
  const derived = await deriveRepo(args.gitClient, remote, args.cwd);
  if (explicit !== void 0) {
    if (derived === null) {
      return explicit;
    }
    if (explicit.toLowerCase() === derived.toLowerCase()) {
      return derived;
    }
    throw new UsageError(
      `--repo '${explicit}' disagrees with the '${remote}' remote ('${derived}'); omit --repo to use the remote, or fix the value`
    );
  }
  if (derived === null) {
    throw new UsageError(
      `--repo is required: could not derive it from the '${remote}' remote (run from a repo checkout with an '${remote}' remote, or pass --repo <owner/name>)`
    );
  }
  return validateRepoSlug(derived);
}
async function deriveRepo(gitClient, remote, cwd) {
  const url = await gitClient.remoteUrl(remote, { cwd });
  if (url === null) {
    return null;
  }
  return parseRemoteUrl(url);
}

// src/git/gh-client.ts
var log8 = createLogger("gh");
var PullRequestSchema = external_exports.object({
  number: external_exports.number().int(),
  headRefName: external_exports.string(),
  baseRefName: external_exports.string(),
  state: external_exports.enum(["OPEN", "CLOSED", "MERGED"]),
  mergeable: external_exports.string().optional(),
  mergeStateStatus: external_exports.string().optional(),
  mergeCommit: external_exports.object({ oid: external_exports.string() }).nullish(),
  url: external_exports.string().optional()
});
var REQUIRED_VIEW_FIELDS = Object.entries(PullRequestSchema.shape).filter(([, schema]) => !schema.isOptional()).map(([key]) => key);
function aggregateChecks(rows) {
  if (rows.length === 0) {
    return "none";
  }
  const buckets = rows.map((r) => (r.bucket ?? "").toLowerCase());
  if (buckets.some((b) => b === "fail" || b === "cancel")) {
    return "failing";
  }
  if (buckets.some((b) => b === "pending")) {
    return "pending";
  }
  return "passing";
}
var GhChecksSchema = external_exports.array(external_exports.object({ bucket: external_exports.string().optional() }));
var GhProtectionSchema = external_exports.object({
  required_status_checks: external_exports.object({ strict: external_exports.boolean().optional(), contexts: external_exports.array(external_exports.string()).optional() }).nullish()
});
var GhRulesSchema = external_exports.array(external_exports.object({ type: external_exports.string().optional() }));
function parseGhJson(result, schema, where) {
  if (result.truncated) {
    throw new Error(
      `gh: output of '${where}' was TRUNCATED (hit maxBuffer) \u2014 refusing to parse a clipped JSON payload`
    );
  }
  const raw = parseJson(result.stdout, where);
  return schema.parse(raw);
}
function ghApiFailure(path3, r) {
  return new Error(`gh api ${path3} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
}
var DefaultGhClient = class {
  runner;
  constructor(runner = defaultGhRunner) {
    this.runner = runner;
  }
  execOpts(opts) {
    const cwd = opts?.cwd;
    return cwd != null && cwd.length > 0 ? { cwd } : {};
  }
  async prList(args, opts) {
    const argv = [
      "pr",
      "list",
      "--head",
      args.head,
      "--state",
      args.state ?? "open",
      "--json",
      "number,headRefName,baseRefName,state,mergeable,mergeStateStatus,mergeCommit,url"
    ];
    if (args.base != null && args.base.length > 0) {
      argv.push("--base", args.base);
    }
    if (args.repo != null && args.repo.length > 0) {
      argv.push("--repo", args.repo);
    }
    const r = await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
    return parseGhJson(r, external_exports.array(PullRequestSchema), "gh pr list");
  }
  async prCreate(args, opts) {
    const r = await runOrThrow(
      "gh",
      this.runner,
      ["pr", "create", "--base", args.base, "--head", args.head, "--title", args.title, "--body", args.body],
      this.execOpts(opts)
    );
    if (r.truncated) {
      throw new Error("gh pr create: output truncated \u2014 cannot trust the emitted PR URL");
    }
    const url = r.stdout.trim().split(/\s+/).pop() ?? "";
    const m = /\/pull\/(\d+)\s*$/.exec(url);
    if (!m) {
      throw new Error(`gh pr create: could not parse PR number from output: ${r.stdout.trim()}`);
    }
    return { number: Number(m[1]), url };
  }
  async prView(number, fields, opts) {
    const requested = Array.from(/* @__PURE__ */ new Set([...REQUIRED_VIEW_FIELDS, ...fields]));
    const r = await runOrThrow(
      "gh",
      this.runner,
      ["pr", "view", String(number), "--json", requested.join(",")],
      this.execOpts(opts)
    );
    return parseGhJson(r, PullRequestSchema, "gh pr view");
  }
  async prChecks(number, opts) {
    const r = await this.runner(["pr", "checks", String(number), "--json", "bucket"], this.execOpts(opts));
    if (r.truncated) {
      throw new Error("gh pr checks: output truncated \u2014 refusing to parse clipped checks JSON");
    }
    const stdout = r.stdout.trim();
    if (stdout === "" || stdout === "[]") {
      if (r.code !== 0 && !/no checks reported/i.test(r.stderr)) {
        throw new Error(`gh pr checks #${number} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
      }
      return "none";
    }
    const rows = GhChecksSchema.parse(parseJson(stdout, "gh pr checks"));
    return aggregateChecks(rows);
  }
  async prMergeSquash(number, opts) {
    const argv = ["pr", "merge", String(number), "--squash"];
    if (opts?.auto === true) {
      argv.push("--auto");
    }
    if (opts?.deleteBranch === true) {
      argv.push("--delete-branch");
    }
    if (opts?.subject !== void 0) {
      argv.push("--subject", opts.subject);
    }
    if (opts?.body !== void 0) {
      argv.push("--body", opts.body);
    }
    await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
  }
  async deleteRemoteBranch(owner, repo, branch, opts) {
    const path3 = `repos/${owner}/${repo}/git/refs/heads/${branch}`;
    const r = await this.runner(["api", "--method", "DELETE", path3], this.execOpts(opts));
    if (r.code !== 0 && !/Reference does not exist|Not Found|HTTP 404/i.test(r.stderr)) {
      throw new Error(`gh api DELETE ${path3} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
    }
  }
  async branchExists(owner, repo, branch, opts) {
    return await this.branchTip(owner, repo, branch, opts) !== null;
  }
  async branchTip(owner, repo, branch, opts) {
    const path3 = `repos/${owner}/${repo}/branches/${branch}`;
    const r = await this.runner(["api", path3], this.execOpts(opts));
    if (r.code === 0) {
      if (r.truncated) {
        throw new Error(`gh api ${path3}: output truncated \u2014 refusing to parse clipped branch JSON`);
      }
      const parsed = external_exports.object({ commit: external_exports.object({ sha: external_exports.string() }) }).parse(parseJson(r.stdout, path3));
      return parsed.commit.sha;
    }
    if (/404|Not Found|Branch not found/i.test(r.stderr)) {
      return null;
    }
    throw ghApiFailure(path3, r);
  }
  async deleteProtection(owner, repo, branch, opts) {
    const argv = ["api", "-X", "DELETE", `/repos/${owner}/${repo}/branches/${branch}/protection`];
    const r = await this.runner(argv, this.execOpts(opts));
    if (r.code !== 0 && !/404|Not Found|Branch not protected/i.test(r.stderr)) {
      throw new Error(`gh api DELETE protection failed for ${owner}/${repo}@${branch}: ${r.stderr}`);
    }
  }
  async issueComment(args, opts) {
    const argv = ["issue", "comment", String(args.number), "--repo", args.repo, "--body", args.body];
    await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
  }
  async listIssueComments(args, opts) {
    const r = await runOrThrow(
      "gh",
      this.runner,
      ["issue", "view", String(args.number), "--repo", args.repo, "--json", "comments"],
      this.execOpts(opts)
    );
    const parsed = parseGhJson(
      r,
      external_exports.object({ comments: external_exports.array(external_exports.object({ body: external_exports.string() })) }),
      "gh issue view comments"
    );
    return parsed.comments.map((c) => c.body);
  }
  async issueClose(args, opts) {
    const argv = ["issue", "close", String(args.number), "--repo", args.repo];
    if (args.comment !== void 0) {
      argv.push("--comment", args.comment);
    }
    await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
  }
  async repoProtection(owner, repo, branch, opts) {
    const path3 = `repos/${owner}/${repo}/branches/${branch}/protection`;
    const r = await this.runner(["api", path3], this.execOpts(opts));
    if (r.code !== 0) {
      if (/404|Not Found|Branch not protected/i.test(r.stderr)) {
        return {
          enabled: false,
          requiredStatusChecks: [],
          strictUpToDate: false,
          hasMergeQueue: false
        };
      }
      throw ghApiFailure(path3, r);
    }
    if (r.truncated) {
      throw new Error(`gh api ${path3}: output truncated \u2014 refusing to parse clipped protection JSON`);
    }
    const raw = GhProtectionSchema.parse(parseJson(r.stdout, path3));
    const rsc = raw.required_status_checks ?? null;
    let mq = false;
    try {
      mq = await this.mergeQueueProbe(owner, repo, branch, opts);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log8.warn(`merge-queue probe failed during protection read (${detail}) \u2014 assuming no queue`);
    }
    return {
      enabled: true,
      requiredStatusChecks: rsc?.contexts ?? [],
      strictUpToDate: rsc?.strict === true,
      hasMergeQueue: mq
    };
  }
  async strengthenStatusChecks(owner, repo, branch, contexts, opts) {
    const path3 = `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`;
    const current = await runOrThrow("gh", this.runner, ["api", path3], this.execOpts(opts));
    const state = parseGhJson(
      current,
      external_exports.object({ checks: external_exports.array(external_exports.object({ context: external_exports.string(), app_id: external_exports.number().nullable() })) }),
      "required status checks"
    );
    const checks = [...state.checks];
    for (const context of contexts) {
      if (!checks.some((check) => check.context === context)) {
        checks.push({ context, app_id: -1 });
      }
    }
    await runOrThrow("gh", this.runner, ["api", "--method", "PATCH", path3, "--input", "-"], {
      ...this.execOpts(opts),
      input: JSON.stringify({ strict: true, checks })
    });
  }
  async putProtection(owner, repo, branch, body, opts) {
    const path3 = `repos/${owner}/${repo}/branches/${branch}/protection`;
    const payload = JSON.stringify({
      required_status_checks: {
        strict: body.strict,
        contexts: body.requiredStatusChecks
      },
      enforce_admins: body.enforceAdmins ?? true,
      required_pull_request_reviews: null,
      restrictions: null,
      // D55: GitHub defaults allow_deletions to FALSE, which made every leftover
      // per-run staging branch undeletable by hand until its protection rule was
      // torn down via the API. The plugin never relies on deletion-blocking (its
      // own teardown always deletes protection first), so keep leftovers deletable.
      allow_deletions: true
    });
    log8.info(`provisioning branch protection for ${owner}/${repo}@${branch}`);
    await runOrThrow("gh", this.runner, ["api", "--method", "PUT", path3, "--input", "-"], {
      ...this.execOpts(opts),
      input: payload
    });
  }
  async mergeQueueProbe(owner, repo, branch, opts) {
    const path3 = `repos/${owner}/${repo}/rules/branches/${branch}`;
    const r = await this.runner(["api", path3], this.execOpts(opts));
    if (r.code !== 0) {
      if (/404|Not Found/i.test(r.stderr)) {
        return false;
      }
      throw ghApiFailure(path3, r);
    }
    if (r.truncated) {
      throw new Error(`gh api ${path3}: output truncated \u2014 refusing to parse clipped ruleset JSON`);
    }
    const rules = GhRulesSchema.safeParse(parseJson(r.stdout, path3));
    return rules.success && rules.data.some((rule) => rule.type === "merge_queue");
  }
};

// src/git/rollup.ts
var log9 = createLogger("git");
var GIT_DEFAULTS = GitSchema.parse({});

// src/git/branch.ts
var DEFAULT_PREFIX = GitSchema.parse({}).branchPrefix;

// src/git/worktree.ts
var log10 = createLogger("git");

// src/git/provision.ts
import path from "node:path";
var log11 = createLogger("provision");
var LOCKFILE_INSTALL = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["package-lock.json", "npm ci"],
  ["npm-shrinkwrap.json", "npm ci"]
];
async function defaultRun(command, cwd) {
  const r = await exec(command, [], { cwd, shell: true });
  return { code: r.code, stderr: r.stderr };
}
async function resolveSetupCommand(worktreePath, setupCommand, fileExists) {
  if (setupCommand !== void 0 && setupCommand.trim().length > 0) {
    return setupCommand;
  }
  for (const [lockfile, command] of LOCKFILE_INSTALL) {
    if (await fileExists(path.join(worktreePath, lockfile))) {
      return command;
    }
  }
  return null;
}
async function provisionWorktree(args) {
  const fileExists = args.fileExists ?? pathExists;
  const run5 = args.run ?? defaultRun;
  const command = await resolveSetupCommand(args.path, args.setupCommand, fileExists);
  if (command === null) {
    log11.debug(`no setupCommand and no lockfile in ${args.path} \u2014 skipping worktree provisioning`);
    return;
  }
  log11.info(`provisioning worktree: ${command} (cwd=${args.path})`);
  const res = await run5(command, args.path);
  if (res.code !== 0) {
    const detail = res.stderr.trim();
    throw new Error(
      `worktree provisioning failed: \`${command}\` exited ${res.code ?? "null"} in ${args.path}` + (detail.length > 0 ? `
${detail}` : "")
    );
  }
}

// src/git/pr.ts
var log12 = createLogger("git");

// src/git/serial-writer.ts
var log13 = createLogger("git");
var MERGE_LOCK_DEFAULTS = {
  ...DEFAULT_FILE_LOCK_TUNING,
  stale: 3e4,
  retries: 100,
  retryMinTimeout: 25,
  retryMaxTimeout: 1e3
};

// src/git/staging.ts
var log14 = createLogger("git");
var GIT_DEFAULTS2 = GitSchema.parse({});

// src/ci/inject-gate-env.ts
var SENTINEL = "# factory:gate-env";
function injectGateEnvIntoWorkflow(text, gateEnv) {
  const keys = Object.keys(gateEnv).sort();
  if (keys.length === 0) {
    return text;
  }
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.trim() === SENTINEL);
  if (idx === -1) {
    return text;
  }
  const indent = nonNull(/^[ \t]*/.exec(at(lines, idx)))[0];
  const block = [`${indent}env:`, ...keys.map((k) => `${indent}  ${k}: ${JSON.stringify(nonNull(gateEnv[k]))}`)];
  lines.splice(idx, 1, ...block);
  return lines.join("\n");
}

// src/ci/render-quality-gate.ts
var CI_RENDERED_GATES = ["type", "lint", "test", "build", "mutation"];
function ciBuiltins(run5, pm) {
  return {
    type: `${run5} tsc --noEmit`,
    lint: `${run5} eslint .`,
    test: `${run5} vitest run`,
    build: `${pm} run build`
  };
}
var SETUP_NODE = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0";
var PNPM_SETUP = "pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6.0.8";
function nodeSetupInputs(runtime, cache) {
  return [
    "  with:",
    `      node-version-file: '${runtime.versionFile}'`,
    ...cache === void 0 ? [] : [`      cache: ${cache}`]
  ];
}
function replaceMarker(lines, marker, block) {
  const idx = lines.findIndex((l) => l.trim() === marker);
  if (idx === -1) {
    throw new Error(`renderQualityGate: template is missing the '${marker}' marker`);
  }
  const indentMatch = /^[ \t]*/.exec(lines[idx] ?? "");
  const indent = indentMatch ? indentMatch[0] : "";
  return [...lines.slice(0, idx), ...block.map((b) => b === "" ? "" : indent + b), ...lines.slice(idx + 1)];
}
function gateCommand(entry, builtin) {
  if (entry.contracted && entry.command !== void 0) {
    return entry.command;
  }
  return builtin;
}
function gateStep(id, opts, builtin) {
  const entry = opts.contract.gates[id];
  if (!entry.contracted) {
    return [`# ${id} gate uncontracted: ${entry.reason}`];
  }
  return [`- run: ${gateCommand(entry, builtin)}`];
}
function setupBlock(opts) {
  const extra = contractSetupSteps(opts.contract.setup_steps ?? []);
  if (opts.packageManager === "pnpm") {
    return [
      `- uses: ${PNPM_SETUP}`,
      `- uses: ${SETUP_NODE}`,
      ...nodeSetupInputs(opts.nodeRuntime, "pnpm"),
      "- run: pnpm install --frozen-lockfile",
      ...extra
    ];
  }
  if (opts.hasLockfile) {
    return [`- uses: ${SETUP_NODE}`, ...nodeSetupInputs(opts.nodeRuntime, "npm"), "- run: npm ci", ...extra];
  }
  return [
    `- uses: ${SETUP_NODE}`,
    ...nodeSetupInputs(opts.nodeRuntime),
    "- run: npm install --no-audit --no-fund",
    ...extra
  ];
}
function contractSetupSteps(steps, cond) {
  const lines = [];
  for (const step of steps) {
    if (step.uses !== void 0) {
      lines.push(...step.name === void 0 ? [] : [`- name: ${JSON.stringify(step.name)}`]);
      lines.push(
        step.name === void 0 ? `- uses: ${JSON.stringify(step.uses)}` : `  uses: ${JSON.stringify(step.uses)}`
      );
      if (cond !== void 0) {
        lines.push(`  ${cond}`);
      }
      if (step.with !== void 0) {
        lines.push(
          "  with:",
          ...Object.entries(step.with).map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
        );
      }
    } else {
      const head = step.name === void 0 ? void 0 : `- name: ${JSON.stringify(step.name)}`;
      if (head !== void 0) {
        lines.push(
          head,
          ...cond === void 0 ? [] : [`  ${cond}`],
          `  run: ${JSON.stringify(step.run ?? "")}`
        );
      } else if (cond !== void 0) {
        lines.push(`- ${cond}`, `  run: ${JSON.stringify(step.run ?? "")}`);
      } else {
        lines.push(`- run: ${JSON.stringify(step.run ?? "")}`);
      }
    }
  }
  return lines;
}
function gatesBlock(opts) {
  const pm = opts.packageManager;
  const lines = [];
  if (opts.hasNextDep) {
    lines.push(
      "- name: Generate Next.js type declarations",
      `  run: ${pm === "pnpm" ? "pnpm next typegen" : "npx next typegen"}`
    );
  }
  const run5 = pm === "pnpm" ? "pnpm exec" : "npx";
  const builtins = ciBuiltins(run5, pm);
  for (const id of CI_RENDERED_GATES) {
    if (id === "mutation") {
      continue;
    }
    const builtin = builtins[id];
    if (builtin === void 0) {
      throw new Error(`renderQualityGate: no builtin CI command for rendered gate '${id}'`);
    }
    lines.push(...gateStep(id, opts, builtin));
  }
  lines.push(
    "  # Build-time env for CI parity with the factory's local merge gate. Managed by",
    "  # the factory: `factory scaffold` replaces the marker below with a real `env:`",
    "  # block rendered from quality.gateEnv (set via `factory configure`). Placeholders",
    "  # only \u2014 real secrets stay in ${{ secrets.* }}. An empty gateEnv leaves the marker.",
    "  # factory:gate-env"
  );
  if (opts.scripts["deps:validate"] !== void 0) {
    lines.push(`- run: ${pm === "pnpm" ? "pnpm deps:validate" : "npm run deps:validate"}`);
  }
  if (pm === "pnpm") {
    lines.push(
      "- name: pnpm audit (non-blocking; pnpm legacy endpoint 410, Snyk covers vulns)",
      "  run: pnpm audit --audit-level=high",
      "  continue-on-error: true"
    );
  } else {
    lines.push(
      "- name: npm audit (non-blocking)",
      "  run: npm audit --audit-level=high",
      "  continue-on-error: true"
    );
  }
  return lines;
}
function mutationSetupBlock(opts) {
  const cond = "if: steps.slice.outputs.slice != ''";
  const extra = contractSetupSteps(opts.contract.setup_steps ?? [], cond);
  if (opts.packageManager === "pnpm") {
    return [
      `- uses: ${PNPM_SETUP}`,
      `  ${cond}`,
      `- uses: ${SETUP_NODE}`,
      `  ${cond}`,
      ...nodeSetupInputs(opts.nodeRuntime, "pnpm"),
      `- ${cond}`,
      "  run: pnpm install --frozen-lockfile",
      ...extra
    ];
  }
  if (opts.hasLockfile) {
    return [
      `- uses: ${SETUP_NODE}`,
      `  ${cond}`,
      ...nodeSetupInputs(opts.nodeRuntime, "npm"),
      `- ${cond}`,
      "  run: npm ci",
      ...extra
    ];
  }
  return [
    `- uses: ${SETUP_NODE}`,
    `  ${cond}`,
    ...nodeSetupInputs(opts.nodeRuntime),
    `- ${cond}`,
    "  run: npm install --no-audit --no-fund",
    ...extra
  ];
}
function waivedMutationBlock(reason) {
  const quoted = reason.replace(/'/g, "''");
  return [
    `# Mutation testing is waived in this repo's gate contract: ${reason}.`,
    '# The aggregator job is kept so the required status check "Mutation Testing"',
    "# stays a universal context across factory repos; it reports green without",
    "# running any mutants.",
    "mutation-testing:",
    "  name: Mutation Testing",
    "  runs-on: ubuntu-latest",
    "  needs: quality",
    "  steps:",
    `    - run: echo 'Mutation testing waived (gate contract): ${quoted}'`
  ];
}
var MUTATION_ROOTS_PLACEHOLDER = "__MUTATION_ROOTS__";
function rootsArgs(roots) {
  return roots.map((r) => `'${r}'`).join(" ");
}
function applyMutationRoots(lines, contract) {
  const args = rootsArgs(mutationRoots(contract));
  return lines.map((line) => line.replace(MUTATION_ROOTS_PLACEHOLDER, args));
}
function renderMutationRegion(lines, opts) {
  const begin = lines.findIndex((l) => l.trim() === "# factory:mutation-begin");
  const end = lines.findIndex((l) => l.trim() === "# factory:mutation-end");
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error("renderQualityGate: template is missing the '# factory:mutation-begin/end' region");
  }
  const mutation = opts.contract.gates.mutation;
  if (!mutation.contracted) {
    const indentMatch = /^[ \t]*/.exec(lines[begin] ?? "");
    const indent = indentMatch ? indentMatch[0] : "";
    const block = waivedMutationBlock(mutation.reason).map((b) => b === "" ? "" : indent + b);
    return [...lines.slice(0, begin), ...block, ...lines.slice(end + 1)];
  }
  let kept = [...lines.slice(0, begin), ...lines.slice(begin + 1, end), ...lines.slice(end + 1)];
  kept = replaceMarker(kept, "# factory:mutation-setup", mutationSetupBlock(opts));
  kept = applyMutationRoots(kept, opts.contract);
  if (opts.packageManager === "npm") {
    kept = kept.map((l) => l.replace("pnpm exec stryker run", "npx stryker run"));
  }
  return kept;
}
function renderMutationNightly(template, opts) {
  if (opts.contract.stack !== "npm") {
    throw new Error(
      `renderMutationNightly: stack '${opts.contract.stack}' is not supported \u2014 the CI quality gate renders for npm-stack repos only (deno/custom repos rely on the local GateRunner)`
    );
  }
  if (!opts.contract.gates.mutation.contracted) {
    return null;
  }
  let lines = renderBaseBranch(template, opts.baseBranch ?? "develop").split("\n");
  lines = replaceMarker(lines, "# factory:mutation-setup", mutationSetupBlock(opts));
  lines = applyMutationRoots(lines, opts.contract);
  if (opts.packageManager === "npm") {
    lines = lines.map((l) => l.replace("pnpm exec stryker run", "npx stryker run"));
  }
  return lines.join("\n");
}
function renderQualityGate(template, opts) {
  if (opts.contract.stack !== "npm") {
    throw new Error(
      `renderQualityGate: stack '${opts.contract.stack}' is not supported \u2014 the CI quality gate renders for npm-stack repos only (deno/custom repos rely on the local GateRunner)`
    );
  }
  let lines = renderBaseBranch(template, opts.baseBranch ?? "develop").split("\n");
  lines = replaceMarker(lines, "# factory:setup", setupBlock(opts));
  lines = replaceMarker(lines, "# factory:gates", gatesBlock(opts));
  lines = renderMutationRegion(lines, opts);
  return lines.join("\n");
}
function renderBaseBranch(template, branch) {
  return template.replaceAll("__FACTORY_BASE_BRANCH__", JSON.stringify(branch));
}

// src/ci/node-runtime.ts
var NODE_VERSION_FILE = ".node-version";
var NVMRC_FILE = ".nvmrc";
var PACKAGE_JSON_FILE = "package.json";
function normalizeVersionFile(name, raw) {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(`scaffold: ${name} must contain a non-empty Node version`);
  }
  if (/\r|\n/.test(value)) {
    throw new Error(`scaffold: ${name} must contain exactly one Node version line`);
  }
  return value;
}
function resolveNodeRuntimeDeclarations(declarations) {
  const nodeVersion = declarations.nodeVersion === void 0 ? void 0 : normalizeVersionFile(NODE_VERSION_FILE, declarations.nodeVersion);
  const nvmrc = declarations.nvmrc === void 0 ? void 0 : normalizeVersionFile(NVMRC_FILE, declarations.nvmrc);
  if (Object.hasOwn(declarations, "enginesNode")) {
    if (typeof declarations.enginesNode !== "string" || declarations.enginesNode.trim().length === 0) {
      throw new Error("scaffold: package.json engines.node must be a non-empty string");
    }
  }
  if (nodeVersion !== void 0 && nvmrc !== void 0 && nodeVersion !== nvmrc) {
    throw new Error(
      `scaffold: ${NODE_VERSION_FILE} (${nodeVersion}) and ${NVMRC_FILE} (${nvmrc}) disagree; keep one source or make them identical`
    );
  }
  if (nodeVersion !== void 0) {
    return { versionFile: NODE_VERSION_FILE };
  }
  if (nvmrc !== void 0) {
    return { versionFile: NVMRC_FILE };
  }
  if (Object.hasOwn(declarations, "enginesNode")) {
    if ((declarations.packageJsonRuntimeShadows?.length ?? 0) > 0) {
      throw new Error(
        `scaffold: package.json engines.node is shadowed by ${declarations.packageJsonRuntimeShadows?.join(", ")}; remove the shadowing field or declare .node-version/.nvmrc`
      );
    }
    return { versionFile: PACKAGE_JSON_FILE };
  }
  throw new Error(
    `scaffold: Node runtime is undeclared; add ${NODE_VERSION_FILE}, ${NVMRC_FILE}, or package.json engines.node`
  );
}

// src/cli/subcommands/target-settings.ts
import { mkdir as mkdir5, readFile as readFile4 } from "node:fs/promises";
import { existsSync as existsSync5 } from "node:fs";
import { join as join6 } from "node:path";
var log15 = createLogger("cli:target-settings");
var FACTORY_TARGET_BASE_ALLOWLIST = [
  "Bash(factory:*)",
  "Bash(git:*)",
  "Bash(gh:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Agent"
];
var DATA_DIR_VERBS = ["Read", "Edit"];
var DEAD_WRITE_RULE = /^Write\(.+\)$/;
function buildTargetDataDirRules(opts) {
  return {
    allowGlobBase: tildeShorten(opts.dataDir, opts.home),
    additionalDir: opts.dataDir
  };
}
function dataDirAllowRules(allowGlobBase) {
  return DATA_DIR_VERBS.map((verb) => `${verb}(${allowGlobBase}/**)`);
}
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function mergeTargetSettings(existing, dataDirRules) {
  const settings = structuredClone(existing);
  let changed = false;
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const currentAllow = Array.isArray(permissions.allow) ? permissions.allow.filter((e) => typeof e === "string") : [];
  const keptAllow = currentAllow.filter((e) => !DEAD_WRITE_RULE.test(e));
  const targetAllow = [...FACTORY_TARGET_BASE_ALLOWLIST, ...dataDirAllowRules(dataDirRules.allowGlobBase)];
  const have = new Set(keptAllow);
  const additions = targetAllow.filter((e) => !have.has(e));
  if (additions.length > 0 || keptAllow.length !== currentAllow.length) {
    permissions.allow = [...keptAllow, ...additions];
    settings.permissions = permissions;
    changed = true;
  }
  const worktree = isObject(settings.worktree) ? settings.worktree : {};
  if (worktree.baseRef !== "head") {
    worktree.baseRef = "head";
    settings.worktree = worktree;
    changed = true;
  }
  return { settings, changed };
}
function staleLocalDirs(dataDirRules) {
  return /* @__PURE__ */ new Set(["${CLAUDE_PLUGIN_DATA}", dataDirRules.allowGlobBase, dataDirRules.additionalDir]);
}
function mergeLocalSettings(existing, dataDirRules) {
  const settings = structuredClone(existing);
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const currentDirs = Array.isArray(permissions.additionalDirectories) ? permissions.additionalDirectories.filter((e) => typeof e === "string") : [];
  const stale = staleLocalDirs(dataDirRules);
  const nextDirs = [...currentDirs.filter((e) => !stale.has(e)), dataDirRules.additionalDir];
  const changed = JSON.stringify(nextDirs) !== JSON.stringify(currentDirs);
  if (changed) {
    permissions.additionalDirectories = nextDirs;
    settings.permissions = permissions;
  }
  return { settings, changed };
}
async function readExistingSettings(path3) {
  if (!existsSync5(path3)) {
    return {};
  }
  const raw = await readFile4(path3, "utf8");
  const parsed = raw.trim().length > 0 ? JSON.parse(raw) : {};
  if (isObject(parsed)) {
    return parsed;
  }
  log15.warn(
    `${path3} is valid JSON but not an object (${Array.isArray(parsed) ? "array" : typeof parsed}); replacing it with the factory settings object`
  );
  return {};
}
async function ensureTargetSettings(opts) {
  const dir = join6(opts.targetRoot, ".claude");
  const path3 = join6(dir, "settings.json");
  const localPath = join6(dir, "settings.local.json");
  const created = !existsSync5(path3);
  const localCreated = !existsSync5(localPath);
  const [existing, existingLocal] = await Promise.all([readExistingSettings(path3), readExistingSettings(localPath)]);
  const { settings, changed } = mergeTargetSettings(existing, opts.dataDirRules);
  const { settings: localSettings, changed: localChanged } = mergeLocalSettings(existingLocal, opts.dataDirRules);
  if (created || changed || localCreated || localChanged) {
    await mkdir5(dir, { recursive: true });
  }
  if (created || changed) {
    await atomicWriteFile(path3, stringifyJson(settings));
  }
  if (localCreated || localChanged) {
    await atomicWriteFile(localPath, stringifyJson(localSettings));
  }
  return {
    settings,
    changed,
    created,
    path: path3,
    local: { settings: localSettings, changed: localChanged, created: localCreated, path: localPath }
  };
}

// src/cli/subcommands/scaffold-gates.ts
import { existsSync as existsSync6, readdirSync, statSync } from "node:fs";
import { mkdir as mkdir6, readFile as readFile5, writeFile } from "node:fs/promises";
import { dirname as dirname5, join as join7 } from "node:path";

// src/verifier/deterministic/scope.ts
function isTestPath(file) {
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs)$/.test(file)) {
    return true;
  }
  if (/_test\.(go|py|rb|exs)$/.test(file)) {
    return true;
  }
  if (/Test\.(java|kt|php)$/.test(file)) {
    return true;
  }
  if (/Tests\.(swift|cs)$/.test(file)) {
    return true;
  }
  if (file.endsWith("_spec.rb")) {
    return true;
  }
  if (/^(tests|test|spec|__tests__)\//.test(file)) {
    return true;
  }
  if (/\/(tests|test|spec|__tests__)\//.test(file)) {
    return true;
  }
  return false;
}
function isDocsPath(file) {
  if (file.startsWith("docs/")) {
    return true;
  }
  if (file.endsWith(".md")) {
    return true;
  }
  return false;
}
function isMutableSrc(file, roots = ["src"]) {
  if (!file.endsWith(".ts") || !roots.some((r) => file.startsWith(r + "/"))) {
    return false;
  }
  if (/\.(test|spec|d)\.ts$/.test(file)) {
    return false;
  }
  if (file.includes("/types/")) {
    return false;
  }
  if (file.includes("/data/")) {
    return false;
  }
  if (/(^|\/)index\.ts$/.test(file)) {
    return false;
  }
  return true;
}
function mutationScope(changedFiles, roots = ["src"]) {
  return filterDedup(changedFiles, (f) => isMutableSrc(f, roots));
}
function diffScopedTestFiles(changedFiles) {
  return filterDedup(changedFiles, isTestPath);
}
function escapeStrykerGlob(p) {
  return p.replace(/[[\]{}()*?!+@|]/g, (c) => `[${c}]`);
}
function filterDedup(files, keep) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const f of files) {
    if (!keep(f)) {
      continue;
    }
    if (seen.has(f)) {
      continue;
    }
    seen.add(f);
    out.push(f);
  }
  return out;
}

// src/verifier/deterministic/strategy.ts
function ran(gate, observed, detail) {
  const evidence = detail === void 0 ? { gate, observed } : { gate, observed, detail };
  return { kind: "ran", evidence };
}
function skip(gate, reason) {
  return { kind: "skip", gate, reason };
}

// src/verifier/deterministic/strategies/proc-strategy.ts
var EXCERPT_MAX_CHARS = 1e3;
function excerpt(text) {
  const trimmed = redactSecrets(text).trim();
  if (trimmed.length <= EXCERPT_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, EXCERPT_MAX_CHARS)}\u2026 (truncated)`;
}
function procOutcome(id, label, result) {
  if (result.truncated) {
    throw new Error(`${id} gate: ${label} output truncated \u2014 refusing to judge a clipped run`);
  }
  const base = `${label} exit=${result.code ?? "null"}`;
  if (result.code === 0) {
    return ran(id, true, base);
  }
  const output = excerpt(result.stderr || result.stdout);
  return ran(id, false, output ? `${base}: ${output}` : base);
}
function procStrategy(id, label, invoke) {
  return {
    id,
    async run(ctx) {
      const opts = { cwd: ctx.worktree };
      const command = contractCommand(ctx.contract, id);
      if (command !== void 0) {
        return procOutcome(id, `contract:${command.join(" ")}`, await ctx.tools.command.run(command, opts));
      }
      return procOutcome(id, label, await invoke(ctx.tools, opts));
    }
  };
}

// src/verifier/deterministic/strategies/lint.ts
var ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc.json",
  ".eslintrc"
];
var ESLINT_BIN = "node_modules/.bin/eslint";
var lintStrategy = {
  id: "lint",
  async run(ctx) {
    const opts = { cwd: ctx.worktree };
    const command = contractCommand(ctx.contract, "lint");
    if (command !== void 0) {
      return procOutcome("lint", `contract:${command.join(" ")}`, await ctx.tools.command.run(command, opts));
    }
    const hasBin = await ctx.tools.fs.exists(ESLINT_BIN, opts);
    if (!hasBin) {
      return skip("lint", "no-eslint-binary");
    }
    const hasConfig = await ctx.tools.fs.existsAny(ESLINT_CONFIGS, opts);
    if (!hasConfig) {
      return skip("lint", "no-eslint-config");
    }
    return procOutcome("lint", "eslint", await ctx.tools.eslint.lint(opts));
  }
};

// src/cli/subcommands/scaffold-gates.ts
function detectStack(targetRoot) {
  const has = (f) => existsSync6(join7(targetRoot, f));
  const hasPkg = has("package.json");
  const hasDeno = has("deno.json") || has("deno.jsonc");
  const hasNodeLock = has("pnpm-lock.yaml") || has("package-lock.json") || has("yarn.lock") || has("bun.lockb");
  if (hasPkg && hasNodeLock) {
    return "npm";
  }
  if (hasDeno) {
    return "deno";
  }
  if (hasPkg) {
    return "npm";
  }
  return "custom";
}
async function readPackageJson(targetRoot) {
  const raw = await readFile5(join7(targetRoot, "package.json"), "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`scaffold: package.json is not valid JSON: ${err.message}`);
  }
}
function hasDep(pkg, name) {
  return pkg.dependencies?.[name] !== void 0 || pkg.devDependencies?.[name] !== void 0;
}
function stripJsoncComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
async function denoHasBuildTask(targetRoot) {
  const jsonc = existsSync6(join7(targetRoot, "deno.jsonc"));
  const file = jsonc ? "deno.jsonc" : "deno.json";
  const raw = await readFile5(join7(targetRoot, file), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(jsonc ? stripJsoncComments(raw) : raw);
  } catch (err) {
    throw new Error(`scaffold: ${file} is not parseable JSON: ${err.message}`);
  }
  const tasks = parsed.tasks;
  return typeof tasks?.build === "string";
}
var yes = { contracted: true };
var no = (reason) => ({ contracted: false, reason });
var MUTATION_ROOT_CANDIDATES = [
  "app",
  "components",
  "lib",
  "utils",
  "db",
  "server",
  "hooks"
];
function hasMutableTs(targetRoot, root) {
  const abs = join7(targetRoot, root);
  if (!existsSync6(abs) || !statSync(abs).isDirectory()) {
    return false;
  }
  const entries = readdirSync(abs, { recursive: true, encoding: "utf8" });
  return entries.some((rel) => isMutableSrc(`${root}/${rel.replaceAll("\\", "/")}`, [root]));
}
function detectMutationRoots(targetRoot) {
  if (hasMutableTs(targetRoot, "src")) {
    return void 0;
  }
  const roots = MUTATION_ROOT_CANDIDATES.filter((r) => hasMutableTs(targetRoot, r));
  return roots.length > 0 ? roots : [];
}
async function resolveNpm(opts) {
  const pkg = await readPackageJson(opts.targetRoot);
  const floor = [];
  if (!hasDep(pkg, "vitest")) {
    floor.push("test gate: no vitest dependency \u2014 install vitest");
  }
  if (!existsSync6(join7(opts.targetRoot, "tsconfig.json"))) {
    floor.push("type gate: no tsconfig.json \u2014 add one");
  }
  if (pkg.scripts?.build === void 0) {
    floor.push("build gate: no scripts.build \u2014 add a build script");
  }
  if (floor.length > 0) {
    throw new Error(`scaffold: gate contract below floor for stack 'npm':
  - ${floor.join("\n  - ")}`);
  }
  const strykerResolvable = hasDep(pkg, "@stryker-mutator/core") || existsSync6(join7(opts.targetRoot, "node_modules", ".bin", "stryker"));
  let mutation;
  if (opts.waiveMutation) {
    mutation = no("waived via --waive mutation");
  } else if (strykerResolvable) {
    const roots = detectMutationRoots(opts.targetRoot);
    if (roots?.length === 0) {
      throw new Error(
        `scaffold: mutation gate: no mutable-source roots found \u2014 no src/ and none of ${MUTATION_ROOT_CANDIDATES.join("/")} contain mutable .ts files. Contracting mutation would make the "Mutation Testing" check a silent no-op; add explicit roots to .factory/gates.json (gates.mutation.roots) or pass --waive mutation`
      );
    }
    mutation = roots === void 0 ? yes : { contracted: true, roots: [...roots] };
  } else {
    throw new Error(
      "scaffold: mutation gate: stryker not installed \u2014 install @stryker-mutator/core or pass --waive mutation to record the waiver"
    );
  }
  const coverageProvider = hasDep(pkg, "@vitest/coverage-v8") || hasDep(pkg, "@vitest/coverage-istanbul");
  let coverage;
  if (coverageProvider) {
    coverage = yes;
  } else if (opts.waiveCoverage) {
    coverage = no("waived via --waive coverage");
  } else {
    throw new Error(
      "scaffold: coverage gate: no vitest coverage provider \u2014 install @vitest/coverage-v8 (or @vitest/coverage-istanbul) or pass --waive coverage to record the waiver"
    );
  }
  const eslintConfig = ESLINT_CONFIGS.some(
    (c) => existsSync6(join7(opts.targetRoot, c)) || opts.projectedSeedFiles?.includes(c) === true
  );
  let lint;
  if (!eslintConfig) {
    lint = no("no eslint config");
  } else if (hasDep(pkg, "eslint") || existsSync6(join7(opts.targetRoot, "node_modules", ".bin", "eslint"))) {
    lint = yes;
  } else {
    lint = no("eslint config present but eslint not installed \u2014 install eslint and re-scaffold");
  }
  return {
    version: 1,
    stack: "npm",
    gates: {
      test: yes,
      tdd: yes,
      coverage,
      mutation,
      sast: opts.securityCommand != null && opts.securityCommand.length > 0 ? yes : no("no quality.securityCommand configured"),
      type: yes,
      lint,
      build: yes
    }
  };
}
async function resolveDeno(opts) {
  const build = await denoHasBuildTask(opts.targetRoot) ? { contracted: true, command: "deno task build" } : no("waived-by-stack: no emit step \u2014 deno check covers compilation");
  return {
    version: 1,
    stack: "deno",
    gates: {
      test: { contracted: true, command: "deno test" },
      tdd: yes,
      coverage: no(
        "waived-by-stack: deno coverage emits lcov, no json-summary \u2014 contract a coverage command that writes coverage/coverage-summary.json or keep waived"
      ),
      mutation: no("waived-by-stack: stryker does not support deno"),
      sast: opts.securityCommand != null && opts.securityCommand.length > 0 ? yes : no("no quality.securityCommand configured"),
      type: { contracted: true, command: "deno check ." },
      lint: { contracted: true, command: "deno lint" },
      build
    }
  };
}
async function resolveGateContract(opts) {
  const stack = detectStack(opts.targetRoot);
  if (stack === "custom") {
    throw new Error(
      "scaffold: gate contract floor unsatisfiable for stack 'custom' \u2014 no package.json (npm) or deno.json/deno.jsonc (deno) detected; the factory requires contractable test + type + build gates"
    );
  }
  const contract = stack === "npm" ? await resolveNpm(opts) : await resolveDeno(opts);
  return GateContractSchema.parse(contract);
}
async function recommendFastCheck(targetRoot) {
  if (detectStack(targetRoot) !== "npm") {
    return false;
  }
  return !hasDep(await readPackageJson(targetRoot), "fast-check");
}
var invalidContractError = (error) => new Error(`scaffold: ${GATE_CONTRACT_REL} is INVALID (${error}) \u2014 fix it or delete it and re-run factory scaffold`);
async function preflightGateContract(opts) {
  const load = await loadGateContract(opts.targetRoot);
  if (load.state === "invalid") {
    throw invalidContractError(load.error);
  }
  if (load.state === "ok") {
    return load.contract;
  }
  return resolveGateContract(opts);
}
async function ensureGateContract(opts) {
  const load = await loadGateContract(opts.targetRoot);
  if (load.state === "invalid") {
    throw invalidContractError(load.error);
  }
  if (load.state === "ok") {
    return { status: "present", stack: load.contract.stack, contract: load.contract };
  }
  const contract = await resolveGateContract(opts);
  const dest = join7(opts.targetRoot, GATE_CONTRACT_REL);
  await mkdir6(dirname5(dest), { recursive: true });
  await writeFile(dest, JSON.stringify(contract, null, 2) + "\n", "utf8");
  return { status: "created", stack: contract.stack, contract };
}

// src/cli/subcommands/scaffold-lock.ts
import { createHash } from "node:crypto";
import { mkdir as mkdir7, readFile as readFile6, writeFile as writeFile2 } from "node:fs/promises";
import { existsSync as existsSync7 } from "node:fs";
import { dirname as dirname6, join as join8 } from "node:path";
var SCAFFOLD_LOCK_REL = ".factory/scaffold.lock";
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
async function loadScaffoldLock(targetRoot) {
  const path3 = join8(targetRoot, SCAFFOLD_LOCK_REL);
  const empty = { version: 1, seeds: {}, managed: {} };
  if (!existsSync7(path3)) {
    return { lock: empty, existed: false, invalid: false };
  }
  try {
    const parsed = JSON.parse(await readFile6(path3, "utf8"));
    const version = typeof parsed === "object" && parsed !== null ? parsed.version : null;
    if (version !== null && version !== void 0 && version !== 1) {
      throw new UnsupportedLockVersionError(version);
    }
    const seeds = typeof parsed === "object" && parsed !== null ? parsed.seeds : null;
    if (typeof seeds !== "object" || seeds === null) {
      return { lock: empty, existed: true, invalid: true };
    }
    const readMap = (value) => {
      const valid = {};
      if (typeof value === "object" && value !== null) {
        for (const [rel, hash] of Object.entries(value)) {
          if (typeof hash === "string") {
            valid[rel] = hash;
          }
        }
      }
      return valid;
    };
    const managed = parsed.managed;
    return { lock: { version: 1, seeds: readMap(seeds), managed: readMap(managed) }, existed: true, invalid: false };
  } catch (err) {
    if (err instanceof UnsupportedLockVersionError) {
      throw err;
    }
    return { lock: empty, existed: true, invalid: true };
  }
}
var UnsupportedLockVersionError = class extends Error {
  constructor(version) {
    super(
      `scaffold: ${SCAFFOLD_LOCK_REL} declares version ${JSON.stringify(version)}, but this engine supports only version 1 \u2014 upgrade the factory plugin (or delete the lock to re-adopt seeds). Nothing was written.`
    );
    this.name = "UnsupportedLockVersionError";
  }
};
async function saveScaffoldLock(targetRoot, lock2) {
  const path3 = join8(targetRoot, SCAFFOLD_LOCK_REL);
  const sorted = (map) => {
    const out = {};
    for (const [rel, hash] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
      out[rel] = hash;
    }
    return out;
  };
  await mkdir7(dirname6(path3), { recursive: true });
  await writeFile2(
    path3,
    JSON.stringify({ version: 1, seeds: sorted(lock2.seeds), managed: sorted(lock2.managed) }, null, 2) + "\n",
    "utf8"
  );
}

// src/cli/subcommands/scaffold.ts
var log16 = createLogger("scaffold");
var HELP2 = `factory scaffold \u2014 prepare a repo for Factory v2

Usage:
  factory scaffold [--repo <owner/name>] [--provision] [--waive mutation|coverage] [--force-managed]

Writes the committed gate contract and CI workflows for git.baseBranch (default:
develop). Requires stable strict branch protection with the configured required
checks. --provision creates or strengthens protection; it never downgrades it.
Runs do not change protection. One PRD produces one feature branch and one PR.

Options:
  --repo <owner/name>   Defaults to origin; a mismatch refuses.
  --provision          Create or strengthen strict protection (external write).
  --waive mutation     Explicitly waive mutation in a new gate contract.
  --waive coverage     Explicitly waive coverage in a new gate contract.
  --force-managed      Re-adopt customized managed files. Never deletes a
                       customized stale workflow.

Commit .factory/gates.json, .factory/scaffold.lock and generated workflows before
creating a run. Existing valid contracts and customized seed configs are preserved.
Pristine managed files update automatically; customized managed files refuse before
writes unless --force-managed is supplied. Playwright seeds require a declared
@playwright/test dependency; scaffold does not install it.
Build environment comes from quality.gateEnv.`;
var GITIGNORE_ENTRIES = [
  "# Claude Code local state (factory scaffold guarantee)",
  ".claude/worktrees/",
  ".claude/plugins/",
  ".claude/file-history/",
  ".claude/backups/",
  ".claude/debug/",
  ".claude/todos/",
  ".claude/plans/",
  ".claude/memory/",
  ".claude/statsig/",
  ".claude/cache/",
  ".claude/paste-cache/",
  ".claude/projects/",
  ".claude/shell-snapshots/",
  ".claude/tasks/",
  ".claude/telemetry/",
  ".claude/workflows/",
  ".claude/history.jsonl",
  ".claude/CLAUDE.local.md",
  ".claude/settings.local.json",
  "# factory plugin state",
  ".claude-plugin-data/",
  "*.worktree"
];
function resolveTemplatesDir() {
  let dir = dirname7(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join9(dir, "templates");
    if (existsSync8(join9(candidate, ".github", "workflows", "quality-gate.yml"))) {
      return candidate;
    }
    const parent = dirname7(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("scaffold: could not locate the plugin templates/ directory");
}
var QUALITY_GATE_REL = ".github/workflows/quality-gate.yml";
var LEGACY_E2E_EXAMPLE_HASHES = [
  "2fcc468328b2070bd07ede3e524bf1bf33ec2957d2d0e9bef29302251a24356d",
  "629824a48477223cfcef02bcb6c850aa9622d73d41c93bc3b76486831a98770e"
];
var MUTATION_NIGHTLY_REL = ".github/workflows/mutation-nightly.yml";
var LEGACY_SHARD_TEST_REL = ".github/scripts/shard-mutation-scope.test.mjs";
var STRYKER_SEED_REL = ".stryker.config.json";
var CI_NET_RELS = [
  QUALITY_GATE_REL,
  ".github/scripts/shard-mutation-scope.mjs",
  ".github/scripts/shard-mutation-scope.node-test.mjs",
  MUTATION_NIGHTLY_REL
];
var TEMPLATE_MANIFEST = [
  { rel: QUALITY_GATE_REL, policy: "managed" },
  { rel: ".github/scripts/shard-mutation-scope.mjs", policy: "managed" },
  { rel: ".github/scripts/shard-mutation-scope.node-test.mjs", policy: "managed" },
  { rel: MUTATION_NIGHTLY_REL, policy: "managed" },
  { rel: STRYKER_SEED_REL, policy: "seed", nodeOnly: true },
  { rel: ".dependency-cruiser.cjs", policy: "seed", nodeOnly: true },
  { rel: "eslint.config.mjs", policy: "seed", nodeOnly: true },
  // e2e (Decision 39) — seed only; @playwright/test must already be a devDependency
  // (scaffold never installs packages) and the config's webServer.command is a TODO
  // the project fills in. testDir here MUST match the engine's fixed E2E_TEST_DIR ("e2e") —
  // and must STAY "./e2e" in any template edit: pristine auto-refresh propagates
  // template changes into already-scaffolded repos, and S4 assertE2ePrereqs
  // refuses an --e2e run whose config declares any other testDir.
  { rel: "playwright.config.ts", policy: "seed", nodeOnly: true },
  {
    rel: "e2e/example.spec.ts",
    policy: "seed",
    nodeOnly: true,
    legacySeedHashes: LEGACY_E2E_EXAMPLE_HASHES
  }
];
async function applyTemplate(entry, templatesDir, targetRoot, lists, lock2, transform) {
  const segs = entry.rel.split("/");
  const src = join9(templatesDir, ...segs);
  const dest = join9(targetRoot, ...segs);
  if (!existsSync8(src)) {
    log16.warn(`template missing, skipping: ${src}`);
    return;
  }
  const render = async () => {
    const text = await readFile7(src, "utf8");
    return transform ? transform(text) : text;
  };
  if (!existsSync8(dest)) {
    const rendered2 = await render();
    await mkdir8(dirname7(dest), { recursive: true });
    await writeFile3(dest, rendered2, "utf8");
    if (lock2) {
      const map = entry.policy === "seed" ? lock2.seeds : lock2.managed;
      map[entry.rel] = sha256Hex(rendered2);
      lock2.dirty = true;
    }
    lists.created.push(entry.rel);
    return;
  }
  if (entry.policy === "seed") {
    const recorded = lock2?.seeds[entry.rel];
    const destText2 = await readFile7(dest, "utf8");
    const destHash = sha256Hex(destText2);
    if (recorded !== void 0) {
      if (destHash === recorded) {
        const rendered2 = await render();
        if (rendered2 === destText2) {
          lists.present.push(entry.rel);
          return;
        }
        await writeFile3(dest, rendered2, "utf8");
        if (lock2) {
          lock2.seeds[entry.rel] = sha256Hex(rendered2);
          lock2.dirty = true;
        }
        lists.updated.push(entry.rel);
        return;
      }
    }
    if (lock2 !== void 0 && entry.legacySeedHashes?.includes(destHash) === true) {
      const rendered2 = await render();
      if (rendered2 !== destText2) {
        await writeFile3(dest, rendered2, "utf8");
        lists.updated.push(entry.rel);
      } else {
        lists.present.push(entry.rel);
      }
      lock2.seeds[entry.rel] = sha256Hex(rendered2);
      lock2.dirty = true;
      return;
    }
    lists.present.push(entry.rel);
    return;
  }
  const [rendered, destText] = await Promise.all([render(), readFile7(dest, "utf8")]);
  const renderedHash = sha256Hex(rendered);
  if (lock2 && lock2.managed[entry.rel] !== renderedHash) {
    lock2.managed[entry.rel] = renderedHash;
    lock2.dirty = true;
  }
  if (rendered === destText) {
    lists.present.push(entry.rel);
    return;
  }
  await writeFile3(dest, rendered, "utf8");
  lists.updated.push(entry.rel);
}
async function readWorkflowFacts(targetRoot) {
  const pnpm = existsSync8(join9(targetRoot, "pnpm-lock.yaml"));
  const raw = await readFile7(join9(targetRoot, "package.json"), "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`scaffold: package.json is not valid JSON: ${err.message}`);
  }
  const declarations = {};
  if (existsSync8(join9(targetRoot, NODE_VERSION_FILE))) {
    declarations.nodeVersion = await readFile7(join9(targetRoot, NODE_VERSION_FILE), "utf8");
  }
  if (existsSync8(join9(targetRoot, NVMRC_FILE))) {
    declarations.nvmrc = await readFile7(join9(targetRoot, NVMRC_FILE), "utf8");
  }
  if (typeof pkg.engines === "object" && pkg.engines !== null && Object.hasOwn(pkg.engines, "node")) {
    declarations.enginesNode = pkg.engines.node;
  }
  const packageJsonRuntimeShadows = [];
  if (typeof pkg.volta === "object" && pkg.volta !== null) {
    if (Object.hasOwn(pkg.volta, "node")) {
      packageJsonRuntimeShadows.push("volta.node");
    }
    if (Object.hasOwn(pkg.volta, "extends")) {
      packageJsonRuntimeShadows.push("volta.extends");
    }
  }
  if (typeof pkg.devEngines === "object" && pkg.devEngines !== null && Object.hasOwn(pkg.devEngines, "runtime")) {
    packageJsonRuntimeShadows.push("devEngines.runtime");
  }
  declarations.packageJsonRuntimeShadows = packageJsonRuntimeShadows;
  return {
    packageManager: pnpm ? "pnpm" : "npm",
    hasLockfile: pnpm || existsSync8(join9(targetRoot, "package-lock.json")),
    scripts: pkg.scripts ?? {},
    hasNextDep: pkg.dependencies?.next !== void 0 || pkg.devDependencies?.next !== void 0,
    nodeRuntime: resolveNodeRuntimeDeclarations(declarations)
  };
}
async function ensureIgnoreFile(root, filename, entries, lists) {
  const path3 = join9(root, filename);
  const rel = relative(root, path3);
  if (!existsSync8(path3)) {
    await writeFile3(path3, entries.join("\n") + "\n", "utf8");
    lists.created.push(rel);
    return;
  }
  const current = await readFile7(path3, "utf8");
  const missing = entries.filter((e) => !current.split("\n").includes(e));
  if (missing.length === 0) {
    lists.present.push(rel);
    return;
  }
  const sep2 = current.endsWith("\n") ? "" : "\n";
  await writeFile3(path3, current + sep2 + missing.join("\n") + "\n", "utf8");
  lists.present.push(rel);
}
async function ensureGitignore(root, lists) {
  await ensureIgnoreFile(root, ".gitignore", GITIGNORE_ENTRIES, lists);
}
var PRETTIERIGNORE_ENTRIES = [
  "# factory plugin: generated bundle (esbuild output, not hand-formatted)",
  ".github/scripts/"
];
async function ensurePrettierignore(root, lists) {
  await ensureIgnoreFile(root, ".prettierignore", PRETTIERIGNORE_ENTRIES, lists);
}
function managedTransform(rel, contract, facts, gateEnv, baseBranch) {
  if (rel === QUALITY_GATE_REL) {
    return (text) => injectGateEnvIntoWorkflow(renderQualityGate(text, { contract, ...facts, baseBranch }), gateEnv);
  }
  if (rel === MUTATION_NIGHTLY_REL) {
    return (text) => nonNull(renderMutationNightly(text, { contract, ...facts, baseBranch }));
  }
  return void 0;
}
async function preflightManagedFiles(opts, lock2, contract) {
  if (contract.stack !== "npm") {
    return void 0;
  }
  const facts = await readWorkflowFacts(opts.targetRoot);
  const conflicts = [];
  let nightlyConflict = false;
  let staleNightlyHash;
  for (const entry of TEMPLATE_MANIFEST) {
    if (entry.policy !== "managed") {
      continue;
    }
    const segs = entry.rel.split("/");
    const dest = join9(opts.targetRoot, ...segs);
    const src = join9(opts.templatesDir, ...segs);
    if (entry.rel === MUTATION_NIGHTLY_REL && !contract.gates.mutation.contracted) {
      if (!existsSync8(dest)) {
        continue;
      }
      const destHash = sha256Hex(await readFile7(dest, "utf8"));
      if (destHash === lock2.managed[entry.rel]) {
        staleNightlyHash = destHash;
      } else {
        nightlyConflict = true;
      }
      continue;
    }
    if (!existsSync8(dest) || !existsSync8(src)) {
      continue;
    }
    const destText = await readFile7(dest, "utf8");
    const transform = managedTransform(
      entry.rel,
      contract,
      facts,
      opts.config.quality.gateEnv,
      opts.config.git.baseBranch
    );
    const text = await readFile7(src, "utf8");
    const rendered = transform ? transform(text) : text;
    if (destText === rendered) {
      continue;
    }
    if (sha256Hex(destText) === lock2.managed[entry.rel]) {
      continue;
    }
    conflicts.push(entry.rel);
  }
  if (conflicts.length === 0 && !nightlyConflict) {
    return staleNightlyHash;
  }
  const nightlyNote = `Note: ${MUTATION_NIGHTLY_REL} is STALE (mutation is uncontracted) and its bytes don't match the recorded scaffold hash \u2014 --force-managed cannot authorize DELETING unproven content; restore it (git checkout) or delete the file yourself.`;
  if (opts.forceManaged === true) {
    if (conflicts.length > 0) {
      log16.warn(`--force-managed: re-adopting customized managed file(s): ${conflicts.join(", ")}`);
    }
    if (nightlyConflict) {
      log16.warn(`--force-managed: ${nightlyNote}`);
    }
    return void 0;
  }
  const allConflicts = nightlyConflict ? [...conflicts, MUTATION_NIGHTLY_REL] : conflicts;
  throw new UsageError(
    `files_conflict: managed file(s) differ from both the shipped template and the recorded scaffold hash: ${allConflicts.join(", ")}. Nothing was written (no seeds, gate contract, lock, or protection changes). Managed files are plugin-authored by contract \u2014 restore them (git checkout) or pass --force-managed to overwrite them with the plugin template and re-record their hashes.` + (nightlyConflict ? ` ${nightlyNote}` : "")
  );
}
async function removeStaleNightly(targetRoot, expectedHash, lists, lock2) {
  const dest = join9(targetRoot, ...MUTATION_NIGHTLY_REL.split("/"));
  const current = sha256Hex(await readFile7(dest, "utf8"));
  if (current !== expectedHash) {
    throw new Error(
      `scaffold: ${MUTATION_NIGHTLY_REL} changed since preflight \u2014 not deleting; re-run factory scaffold`
    );
  }
  await unlink3(dest);
  Reflect.deleteProperty(lock2.managed, MUTATION_NIGHTLY_REL);
  lock2.dirty = true;
  lists.removed.push(MUTATION_NIGHTLY_REL);
}
async function runScaffold(opts) {
  const lists = { created: [], present: [], updated: [], removed: [] };
  const isNodePackage = existsSync8(join9(opts.targetRoot, "package.json"));
  const pkg = isNodePackage ? JSON.parse(await readFile7(join9(opts.targetRoot, "package.json"), "utf8")) : void 0;
  const hasPlaywright = pkg?.dependencies?.["@playwright/test"] !== void 0 || pkg?.devDependencies?.["@playwright/test"] !== void 0;
  const lockLoad = await loadScaffoldLock(opts.targetRoot);
  const lock2 = {
    seeds: { ...lockLoad.lock.seeds },
    managed: { ...lockLoad.lock.managed },
    dirty: lockLoad.invalid
  };
  const projectedSeedFiles = TEMPLATE_MANIFEST.filter(
    (e) => e.policy === "seed" && (e.nodeOnly !== true || isNodePackage) && existsSync8(join9(opts.templatesDir, ...e.rel.split("/"))) && !existsSync8(join9(opts.targetRoot, ...e.rel.split("/")))
  ).map((e) => e.rel);
  const preflightContract = await preflightGateContract({
    targetRoot: opts.targetRoot,
    securityCommand: opts.config.quality.securityCommand,
    waiveMutation: opts.waiveMutation === true,
    waiveCoverage: opts.waiveCoverage === true,
    projectedSeedFiles
  });
  const staleNightlyHash = await preflightManagedFiles(opts, lock2, preflightContract);
  let lockReported = false;
  const reportLock = (saved) => {
    if (lockReported) {
      return;
    }
    if (saved) {
      lockReported = true;
      if (lockLoad.existed) {
        lists.present.push(SCAFFOLD_LOCK_REL);
      } else {
        lists.created.push(SCAFFOLD_LOCK_REL);
        log16.info(`wrote ${SCAFFOLD_LOCK_REL} (pristine-tracking) \u2014 COMMIT it alongside the seeds`);
      }
    } else if (lockLoad.existed) {
      lists.present.push(SCAFFOLD_LOCK_REL);
      lockReported = true;
    }
  };
  const persistLock = async () => {
    if (!lock2.dirty) {
      return;
    }
    const toSave = { version: 1, seeds: lock2.seeds, managed: lock2.managed };
    await saveScaffoldLock(opts.targetRoot, toSave);
    lock2.dirty = false;
    reportLock(true);
  };
  for (const entry of TEMPLATE_MANIFEST) {
    if (CI_NET_RELS.includes(entry.rel) || entry.rel === STRYKER_SEED_REL) {
      continue;
    }
    if (!hasPlaywright && (entry.rel === "playwright.config.ts" || entry.rel === "e2e/example.spec.ts")) {
      log16.info(`not seeding ${entry.rel}: @playwright/test is not declared; install it before opting into e2e`);
      continue;
    }
    if (entry.nodeOnly === true && !isNodePackage) {
      continue;
    }
    await applyTemplate(entry, opts.templatesDir, opts.targetRoot, lists, lock2);
  }
  await persistLock();
  reportLock(false);
  const gates = await ensureGateContract({
    targetRoot: opts.targetRoot,
    securityCommand: opts.config.quality.securityCommand,
    waiveMutation: opts.waiveMutation === true,
    waiveCoverage: opts.waiveCoverage === true
  });
  if (gates.status === "created") {
    lists.created.push(GATE_CONTRACT_REL);
    log16.info(
      `wrote ${GATE_CONTRACT_REL} (stack: ${gates.stack}) \u2014 COMMIT it; 'factory run' requires the contract tracked`
    );
  } else {
    lists.present.push(GATE_CONTRACT_REL);
  }
  if (isNodePackage) {
    const present = STRYKER_CONFIG_BASENAMES.filter((b) => existsSync8(join9(opts.targetRoot, b)));
    const others = present.filter((b) => b !== STRYKER_SEED_REL);
    if (others.length > 0) {
      log16.warn(
        `not seeding ${STRYKER_SEED_REL}: found existing Stryker config(s) ${others.join(", ")} \u2014 discovery order loads '${nonNull(present[0])}'; consolidate into ONE config (shadowed siblings are silently ignored by Stryker)`
      );
    } else {
      const roots = mutationRoots(gates.contract);
      const includes = roots.map((r) => `"${r}/**/*.ts"`).join(",\n        ");
      const entry = nonNull(TEMPLATE_MANIFEST.find((e) => e.rel === STRYKER_SEED_REL));
      await applyTemplate(
        entry,
        opts.templatesDir,
        opts.targetRoot,
        lists,
        lock2,
        (text) => text.replace('"src/**/*.ts"', includes)
      );
      await persistLock();
    }
  }
  if (gates.contract.stack === "npm") {
    const facts = await readWorkflowFacts(opts.targetRoot);
    const legacyShardTest = join9(opts.targetRoot, ...LEGACY_SHARD_TEST_REL.split("/"));
    if (existsSync8(legacyShardTest)) {
      await rm2(legacyShardTest);
      lists.updated.push(LEGACY_SHARD_TEST_REL);
    }
    for (const entry of TEMPLATE_MANIFEST) {
      if (!CI_NET_RELS.includes(entry.rel)) {
        continue;
      }
      if (entry.rel === MUTATION_NIGHTLY_REL && !gates.contract.gates.mutation.contracted) {
        continue;
      }
      const transform = managedTransform(
        entry.rel,
        gates.contract,
        facts,
        opts.config.quality.gateEnv,
        opts.config.git.baseBranch
      );
      await applyTemplate(entry, opts.templatesDir, opts.targetRoot, lists, lock2, transform);
    }
    await persistLock();
    if (!gates.contract.gates.mutation.contracted && staleNightlyHash !== void 0) {
      await removeStaleNightly(opts.targetRoot, staleNightlyHash, lists, lock2);
    }
    await persistLock();
    await ensurePrettierignore(opts.targetRoot, lists);
  } else {
    log16.info(
      `skipping the CI net (${CI_NET_RELS.join(", ")}) \u2014 the quality-gate workflow renders for npm-stack repos only; stack '${gates.stack}' relies on the local GateRunner`
    );
  }
  if (lists.updated.length > 0) {
    log16.info(`auto-updated ${lists.updated.length} outdated scaffold file(s): ${lists.updated.join(", ")}`);
  }
  if (lists.removed.length > 0) {
    log16.info(`removed ${lists.removed.length} stale scaffold file(s): ${lists.removed.join(", ")}`);
  }
  if (await recommendFastCheck(opts.targetRoot)) {
    log16.info(
      "property-based testing: fast-check not installed \u2014 consider 'npm i -D fast-check' so the test-writer can write property tests (advisory only)"
    );
  }
  await ensureGitignore(opts.targetRoot, lists);
  const settings = await ensureTargetSettings({
    targetRoot: opts.targetRoot,
    dataDirRules: opts.dataDirRules
  });
  const settingsRel = relative(opts.targetRoot, settings.path);
  if (settings.created) {
    lists.created.push(settingsRel);
  } else {
    lists.present.push(settingsRel);
  }
  const branch = opts.config.git.baseBranch;
  const required = effectiveProfiles(opts.config.git, requiredCheckExtras(gates.contract)).run;
  let state = await probeProtection({ ghClient: opts.ghClient, owner: opts.owner, repo: opts.repo, branch });
  if (opts.provision) {
    state = await provisionStableProtection({
      ghClient: opts.ghClient,
      owner: opts.owner,
      repo: opts.repo,
      branch,
      requiredChecks: required,
      provision: true
    });
  }
  requireProtectionOrRefuse(state, required, branch);
  const provisioned = opts.provision;
  return {
    repo: `${opts.owner}/${opts.repo}`,
    files_created: lists.created,
    files_present: lists.present,
    files_updated: lists.updated,
    files_removed: lists.removed,
    protection: {
      enabled: state.enabled,
      strict_up_to_date: state.strictUpToDate,
      required_status_checks: state.requiredStatusChecks,
      provisioned
    },
    settings: {
      created: settings.created,
      changed: settings.changed,
      local: { created: settings.local.created, changed: settings.local.changed }
    },
    stack: gates.stack,
    gates_contract: gates.status
  };
}
async function resolveScaffoldRepo(args, overrides = {}) {
  const slug = await resolveRepo({
    explicit: optionalString(args.flag("repo")),
    cwd: overrides.cwd ?? process.cwd(),
    gitClient: overrides.gitClient ?? new DefaultGitClient()
  });
  return splitRepoSlug(slug);
}
async function run2(argv) {
  const args = parseArgs(argv, { booleans: ["provision", "force-managed"] });
  if (args.flag("help") === true) {
    return emitHelp(HELP2);
  }
  const waived = args.all("waive").map(String);
  for (const w of waived) {
    if (w !== "mutation" && w !== "coverage") {
      throw new UsageError(`--waive accepts only 'mutation' or 'coverage' (got '${w}')`);
    }
  }
  const { owner, repo } = await resolveScaffoldRepo(args);
  const dataDir = resolveDataDir();
  const report = await runScaffold({
    targetRoot: process.cwd(),
    templatesDir: resolveTemplatesDir(),
    owner,
    repo,
    config: loadConfig(),
    ghClient: new DefaultGhClient(),
    // Bake the resolved data dir into the target permission rules.
    dataDirRules: buildTargetDataDirRules({ dataDir, home: homedir2() }),
    provision: args.flag("provision") === true,
    hasActiveRun: () => new StateManager({ dataDir }).hasOtherActiveForRepo(`${owner}/${repo}`),
    waiveMutation: waived.includes("mutation"),
    waiveCoverage: waived.includes("coverage"),
    forceManaged: args.flag("force-managed") === true
  });
  emitJson(report);
  return EXIT.OK;
}
var scaffoldCommand = {
  describe: "Prepare a repo (templates + develop branch protection) for the pipeline",
  run: withUsageGuard("scaffold", run2)
};

// src/cli/subcommands/spec.ts
import { join as join14 } from "node:path";

// src/spec/snapshot.ts
async function repositorySnapshot(root, config) {
  const git = async (args) => (await execOrThrow("git", args, { cwd: root })).stdout.trim();
  await git(["fetch", "origin", config.git.baseBranch]);
  const base_sha = await git(["rev-parse", `origin/${config.git.baseBranch}`]);
  const paths = (await git(["ls-tree", "-r", "--name-only", base_sha])).split("\n");
  const selected = paths.filter(
    (path3) => [
      "AGENTS.md",
      "CLAUDE.md",
      "package.json",
      ".factory/gates.json",
      "docs/glossary.md",
      "docs/architecture/overview.md"
    ].includes(path3) || /^docs\/(?:adr|contracts)\/.*\.md$/.test(path3)
  );
  const contracts = {};
  for (const path3 of selected) {
    contracts[path3] = await git(["show", `${base_sha}:${path3}`]);
  }
  return { base_sha, contracts };
}

// src/quota/usage-source.ts
import { existsSync as existsSync9, readFileSync as readFileSync3 } from "node:fs";
import { join as join10 } from "node:path";
var log17 = createLogger("quota:usage");
var STALE_CEILING_SECONDS = 3600;
var STALE_WARN_SECONDS = 120;
var RawWindowSchema = external_exports.object({
  used_percentage: external_exports.unknown().optional(),
  resets_at: external_exports.unknown().optional()
}).passthrough();
var RawCacheSchema = external_exports.object({
  five_hour: RawWindowSchema.optional(),
  seven_day: RawWindowSchema.optional(),
  captured_at: external_exports.unknown().optional()
}).passthrough();
function asFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}
function unavailable(reason) {
  return { kind: "unavailable", reason };
}
function readingFromCache(raw, nowEpoch2) {
  const parsed = RawCacheSchema.safeParse(raw);
  if (!parsed.success) {
    return unavailable("usage-cache-malformed");
  }
  const cache = parsed.data;
  const capturedAt = asFiniteNumber(cache.captured_at) ?? 0;
  const age = nowEpoch2 - capturedAt;
  if (age > STALE_CEILING_SECONDS) {
    return unavailable("usage-cache-too-stale");
  }
  if (age > STALE_WARN_SECONDS) {
    log17.warn(`usage-cache.json is ${age}s old (>${STALE_WARN_SECONDS}s) \u2014 data may be stale`);
  }
  const fivePct = asFiniteNumber(cache.five_hour?.used_percentage);
  const sevenPct = asFiniteNumber(cache.seven_day?.used_percentage);
  if (fivePct === null || sevenPct === null) {
    return unavailable("usage-cache-fields-missing");
  }
  const fiveResets = asFiniteNumber(cache.five_hour?.resets_at);
  const sevenResets = asFiniteNumber(cache.seven_day?.resets_at);
  if (fiveResets === null || sevenResets === null) {
    return unavailable("resets-at-missing");
  }
  if (fiveResets <= nowEpoch2) {
    return unavailable("five-hour-window-reset");
  }
  if (sevenResets <= nowEpoch2) {
    return unavailable("seven-day-window-reset");
  }
  return {
    kind: "available",
    fiveHour: { utilizationPct: fivePct, resetsAtEpoch: fiveResets },
    sevenDay: { utilizationPct: sevenPct, resetsAtEpoch: sevenResets },
    capturedAt
  };
}
function usageCachePath(dataDir) {
  return join10(dataDir, "usage-cache.json");
}
var StatuslineUsageSignal = class {
  opts;
  constructor(opts = {}) {
    this.opts = opts;
  }
  read() {
    return Promise.resolve(this.readSync());
  }
  readSync() {
    const now = (this.opts.now ?? nowEpoch)();
    let dataDir;
    try {
      dataDir = resolveDataDir(this.opts);
    } catch {
      return unavailable("usage-cache-missing");
    }
    const file = usageCachePath(dataDir);
    if (!existsSync9(file)) {
      log17.warn(`usage-cache.json not found at ${file}; emitting unavailable sentinel`);
      return unavailable("usage-cache-missing");
    }
    let raw;
    try {
      raw = parseJson(readFileSync3(file, "utf8"), file);
    } catch (err) {
      log17.warn(
        `usage-cache.json is malformed at ${file}: ${err.message}; emitting unavailable sentinel`
      );
      return unavailable("usage-cache-malformed");
    }
    return readingFromCache(raw, now);
  }
};

// src/quota/window.ts
var FIVE_HOUR_WINDOW_SECONDS = 18e3;
var SEVEN_DAY_WINDOW_SECONDS = 604800;
var SECONDS_PER_HOUR = 3600;
var SECONDS_PER_DAY = 86400;
var MIN_HOUR = 1;
var MAX_HOUR = 5;
var MIN_DAY = 1;
var MAX_DAY = 7;
function clamp(value, lo, hi) {
  if (value < lo) {
    return lo;
  }
  if (value > hi) {
    return hi;
  }
  return value;
}
function computeWindowHour(resetsAtEpoch, nowEpoch2) {
  const windowStart = resetsAtEpoch - FIVE_HOUR_WINDOW_SECONDS;
  const elapsed = nowEpoch2 - windowStart;
  const hour = Math.floor(elapsed / SECONDS_PER_HOUR) + 1;
  return clamp(hour, MIN_HOUR, MAX_HOUR);
}
function computeWindowDay(resetsAtEpoch, nowEpoch2) {
  const windowStart = resetsAtEpoch - SEVEN_DAY_WINDOW_SECONDS;
  const elapsed = nowEpoch2 - windowStart;
  const day = Math.floor(elapsed / SECONDS_PER_DAY) + 1;
  return clamp(day, MIN_DAY, MAX_DAY);
}
function hourlyThresholdFor(hour, hourlyThresholds) {
  return curveValue(hour, hourlyThresholds);
}
function dailyThresholdFor(day, dailyThresholds) {
  return curveValue(day, dailyThresholds);
}
function curveValue(position, curve) {
  if (curve.length === 0) {
    throw new RangeError("quota curve is empty \u2014 cannot resolve a threshold (config defect)");
  }
  const idx = clamp(position - 1, 0, curve.length - 1);
  return at(curve, idx);
}

// src/quota/pacer.ts
function evaluate(reading, config, nowEpoch2) {
  if (reading.kind === "unavailable") {
    return { kind: "unavailable-halt", reason: `usage unavailable: ${reading.reason}` };
  }
  const { hourlyThresholds, dailyThresholds } = config.quota;
  const windowHour = computeWindowHour(reading.fiveHour.resetsAtEpoch, nowEpoch2);
  const hourlyCap = hourlyThresholdFor(windowHour, hourlyThresholds);
  const fiveOver = reading.fiveHour.utilizationPct > hourlyCap;
  const windowDay = computeWindowDay(reading.sevenDay.resetsAtEpoch, nowEpoch2);
  const dailyCap = dailyThresholdFor(windowDay, dailyThresholds);
  const sevenOver = reading.sevenDay.utilizationPct > dailyCap;
  if (sevenOver) {
    return {
      kind: "suspend-7d",
      resetsAtEpoch: reading.sevenDay.resetsAtEpoch,
      reason: `7d quota over curve: ${reading.sevenDay.utilizationPct}% used > ${dailyCap}% cap at window-day ${windowDay}`
    };
  }
  if (fiveOver) {
    return {
      kind: "pause-5h",
      resetsAtEpoch: reading.fiveHour.resetsAtEpoch,
      reason: `5h quota over curve: ${reading.fiveHour.utilizationPct}% used > ${hourlyCap}% cap at window-hour ${windowHour}`
    };
  }
  return { kind: "proceed" };
}

// src/core/phase-machine/phases.ts
var TaskPhaseEnum = external_exports.enum(TASK_PHASES);
var RunPhaseEnum = external_exports.enum(["finalize"]);

// src/core/phase-machine/spawn.ts
var SpawnRoleEnum = external_exports.enum([
  "test-writer",
  "implementer",
  "implementation-reviewer",
  "quality-reviewer",
  "silent-failure-hunter",
  "systemic-failure-reviewer",
  "database-design-reviewer",
  "scribe"
]);
var SPEC_GENERATOR_AGENT_TYPE = "spec-generator";
var SPEC_REVIEWER_AGENT_TYPE = "spec-reviewer";
var AgentSpecSchema = external_exports.object({
  /** The reviewer/producer role (closed set). */
  role: SpawnRoleEnum,
  /** The runner-facing `Task(subagent_type)` value, spawned verbatim (C4). */
  agent_type: external_exports.string().min(1),
  /** Worktree isolation. Defaults to "worktree". */
  isolation: external_exports.enum(["worktree", "none"]).default("worktree"),
  /** Model identifier to run the agent on (non-empty; WS8 resolves the value). */
  model: external_exports.string().min(1),
  /**
   * Optional hard turn budget for the agent (positive integer). Omitted ⇒ the runner
   * falls back to the agent's own frontmatter `maxTurns` (single-source-of-truth —
   * mirrors how `effort` already works below). Set only when the engine deliberately
   * overrides the frontmatter default.
   */
  max_turns: external_exports.number().int().positive().optional(),
  /**
   * The composed agent prompt, spawned VERBATIM (3b(i)/(ii)). Producer specs
   * always set it (`handlers.ts` `producerSpawn`); panel reviewer specs omit it —
   * the runner still builds those prompts inline from `agents/<role>.md` +
   * `skills/review-protocol/SKILL.md` (unchanged).
   */
  prompt: external_exports.string().min(1).optional(),
  /**
   * Optional effort/reasoning level to spawn at (the closed {@link EffortEnum}:
   * low|medium|high|xhigh|max). Omitted ⇒ inherit the spawn default. Set by the
   * producer dial's effort climb (`model-dial.ts`) on high escalation rungs.
   */
  effort: EffortEnum.optional()
});
var CrossVendorStampSchema = external_exports.union([
  external_exports.object({ status: external_exports.literal("present"), model: external_exports.string().min(1), prompt: external_exports.string().min(1) }),
  external_exports.object({ status: external_exports.literal("absent"), reason: external_exports.string().min(1) })
]);
var VerifierSpecSchema = external_exports.object({
  agent_type: external_exports.string().min(1),
  model: external_exports.string().min(1),
  isolation: external_exports.enum(["worktree", "none"]).default("worktree"),
  prompt_template: external_exports.string().min(1),
  interpolate_fields: external_exports.array(external_exports.string().min(1)).min(1)
});
var SpawnRequestSchema = external_exports.object({
  /** Engine resumes here after the agents return. A per-task phase. */
  resume_phase: TaskPhaseEnum,
  /** Agents to spawn; at least one (an empty request is a programming error). */
  agents: external_exports.array(AgentSpecSchema).min(1),
  /** Cross-vendor resolution — verify panel manifests only (S5/C). */
  cross_vendor: CrossVendorStampSchema.optional(),
  /** Finding-verifier spawn template — verify panel manifests only (3b/iii). */
  verifier_spec: VerifierSpecSchema.optional()
});

// src/core/phase-machine/result.ts
function assertNever(x) {
  throw new Error(`assertNever: unhandled value ${JSON.stringify(x)} \u2014 a PhaseResult.kind was not handled`);
}

// src/spec/schema.ts
var SpecTaskSchema = external_exports.object({
  /** Stable task id within the spec (charset enforced by the consumer). */
  task_id: external_exports.string().min(1),
  /** Short human title. */
  title: external_exports.string().min(1),
  /** What the task delivers. */
  description: external_exports.string().min(1),
  /**
   * Exact repository-relative files touched by a coherent task. There is
   * no arbitrary file cap; execution validation checks paths and dependencies.
   */
  files: external_exports.array(external_exports.string().min(1)).min(1),
  slice_id: external_exports.string().min(1).optional(),
  requirement_ids: external_exports.array(external_exports.string().min(1)).min(1).optional(),
  /** ≥1 acceptance criterion; each must be testable (gate enforces non-vagueness). */
  acceptance_criteria: external_exports.array(external_exports.string().min(1)).min(1),
  /** Concrete test descriptions to write first (TDD). ≥1. */
  tests_to_write: external_exports.array(external_exports.string().min(1)).min(1),
  /** Task ids this task depends on (may be empty for a root task). */
  depends_on: external_exports.array(external_exports.string().min(1)).default([]),
  /**
   * The SINGLE producer dial (Decision 25) — the generator's whole-PRD
   * difficulty×stakes judgment. Imported from the frozen seam; the legacy
   * routine/feature/security values parse-fail here.
   */
  risk_tier: RiskTierEnum,
  /** Why this tier — required so the dial is a judgment, not a coin flip. */
  risk_rationale: external_exports.string().min(1),
  /** Per-task TDD opt-out (read from the spec, never from runtime state). */
  tdd_exempt: external_exports.boolean().optional()
}).strict();
var SpecTasksSchema = external_exports.array(SpecTaskSchema).min(1);
var SpecManifestSchema = external_exports.object({
  spec_id: external_exports.string().min(1),
  issue_number: external_exports.number().int().positive(),
  slug: external_exports.string().min(1),
  /** Repo identity, e.g. "owner/name" (sanitized to a path segment by the store). */
  repo: external_exports.string().min(1),
  /** ISO-8601 creation timestamp. */
  generated_at: external_exports.string().min(1),
  tasks: SpecTasksSchema
}).strict();
function parseSpecTasks(raw) {
  return SpecTasksSchema.parse(raw);
}
function parseSpecManifest(raw) {
  return SpecManifestSchema.parse(raw);
}
var PrdSchema = external_exports.object({
  issue_number: external_exports.number(),
  title: external_exports.string(),
  body: external_exports.string(),
  labels: external_exports.array(external_exports.string()),
  body_truncated: external_exports.boolean()
}).strict();
function parsePrd(raw, source) {
  const result = PrdSchema.safeParse(raw);
  if (!result.success) {
    const where = source != null && source.length > 0 ? ` (${source})` : "";
    throw new Error(`invalid PRD snapshot${where}: ${result.error.message}`);
  }
  return result.data;
}

// src/spec/gh.ts
var log18 = createLogger("spec:gh");
var GhAuthError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GhAuthError";
  }
};
var IssueNotFoundError = class extends Error {
  issueNumber;
  constructor(issueNumber, message) {
    super(message);
    this.name = "IssueNotFoundError";
    this.issueNumber = issueNumber;
  }
};
var AUTH_HINT = /not logged|gh auth login|authentication|HTTP 401|requires authentication/i;
var NOT_FOUND_HINT = /could not resolve to|not found|HTTP 404|no issue|GraphQL: Could not/i;
var RealGhClient = class {
  exec;
  bodyMaxBytes;
  constructor(opts = {}) {
    this.exec = opts.exec ?? exec;
    this.bodyMaxBytes = opts.bodyMaxBytes ?? SPEC_DEFAULTS.prdBodyMaxBytes;
  }
  async fetchPrd(issueNumber, opts = {}) {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`fetchPrd: issue number must be a positive integer, got ${issueNumber}`);
    }
    const args = ["issue", "view", String(issueNumber), "--json", "number,title,body,labels"];
    if (opts.repo != null && opts.repo.length > 0) {
      args.push("--repo", opts.repo);
    }
    const result = await this.exec("gh", args, { timeoutMs: 3e4 });
    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      if (AUTH_HINT.test(stderr)) {
        throw new GhAuthError(`gh is not authenticated (run \`gh auth login\`): ${stderr}`);
      }
      if (NOT_FOUND_HINT.test(stderr)) {
        throw new IssueNotFoundError(
          issueNumber,
          `issue #${issueNumber} not found${opts.repo != null && opts.repo.length > 0 ? ` in ${opts.repo}` : ""}: ${stderr}`
        );
      }
      throw new Error(`gh issue view #${issueNumber} failed (code=${result.code ?? "null"}): ${stderr}`);
    }
    if (result.truncated) {
      throw new Error(`gh issue view #${issueNumber} output was truncated; cannot parse a clipped payload`);
    }
    const raw = parseJson(result.stdout, `gh issue #${issueNumber}`);
    const parsed = raw !== null && typeof raw === "object" ? raw : {};
    const title = typeof parsed.title === "string" ? parsed.title : "";
    if (title.length === 0) {
      throw new Error(`gh issue view #${issueNumber}: missing or empty title in response`);
    }
    const rawBody = typeof parsed.body === "string" ? parsed.body : "";
    const { body, body_truncated } = this.capBody(rawBody);
    if (body_truncated) {
      log18.warn(`PRD body for issue #${issueNumber} exceeded ${this.bodyMaxBytes} bytes; truncated`);
    }
    const labels = Array.isArray(parsed.labels) ? parsed.labels.map(
      (l) => l != null && typeof l === "object" && "name" in l && typeof l.name === "string" ? l.name : typeof l === "string" ? l : null
    ).filter((l) => l !== null) : [];
    return {
      issue_number: issueNumber,
      title,
      body,
      labels,
      body_truncated
    };
  }
  /** Cap the body to `bodyMaxBytes` on a UTF-8 byte boundary. */
  capBody(body) {
    const buf = Buffer.from(body, "utf8");
    if (buf.length <= this.bodyMaxBytes) {
      return { body, body_truncated: false };
    }
    const clipped = buf.subarray(0, this.bodyMaxBytes).toString("utf8");
    return { body: clipped, body_truncated: true };
  }
};

// src/spec/store.ts
import { access as access2, readFile as readFile9, readdir as readdir2, rm as rm3 } from "node:fs/promises";
import { join as join12 } from "node:path";

// src/spec/ledger.ts
import { readFile as readFile8, mkdir as mkdir9 } from "node:fs/promises";
import { join as join11, dirname as dirname8 } from "node:path";
var LEDGER_FILE = "ledger.json";
var LedgerEntrySchema = external_exports.object({
  task_id: external_exports.string().min(1),
  run_id: external_exports.string().min(1),
  /** GitHub PR number, when the entry came from a shipped PR. */
  pr_number: external_exports.number().int().positive().optional(),
  /** The commit SHAs that carry this task's work (min 1 — an unevidenced entry is useless). */
  shas: external_exports.array(external_exports.string().min(7)).min(1),
  verified_at: external_exports.string().min(1),
  source: external_exports.enum(["shipped", "already-satisfied"])
}).strict();
var LedgerSchema = external_exports.object({ entries: external_exports.array(LedgerEntrySchema) }).strict();
function ledgerPath(dataDir, repo, specId) {
  return join11(specDir(dataDir, repo, specId), LEDGER_FILE);
}
async function readLedger(dataDir, repo, specId) {
  const path3 = ledgerPath(dataDir, repo, specId);
  let raw;
  try {
    raw = await readFile8(path3, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return { entries: [] };
    }
    throw err;
  }
  return LedgerSchema.parse(parseJson(raw, path3));
}

// src/spec/store.ts
var log19 = createLogger("spec:store");
var SPEC_MD_FILE = "spec.md";
var TASKS_FILE = "tasks.json";
var PRD_FILE = "prd.json";
function makeSpecId(issueNumber, slug) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`makeSpecId: issue number must be a positive integer, got ${issueNumber}`);
  }
  const safeSlug = slugify(slug);
  if (safeSlug.length === 0) {
    throw new Error(`makeSpecId: slug '${slug}' has no usable characters`);
  }
  const specId = `${issueNumber}-${safeSlug}`;
  validateId(specId, "spec-id");
  return specId;
}
function issueOf(specId) {
  const m = /^(\d+)-/.exec(specId);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
var SpecStore = class {
  dataDir;
  docsRoot;
  constructor(opts = {}) {
    this.dataDir = resolveDataDir(opts);
    this.docsRoot = opts.docsRoot ?? join12(process.cwd(), "docs");
  }
  /** Read the spec's shipped-work ledger (Decision 70). ENOENT → empty; garbage → LOUD. */
  async ledger(repo, specId) {
    return readLedger(this.dataDir, repo, specId);
  }
  /**
   * Resolve an existing spec for `(repo, issueNumber)` — Δ X reuse. Scans the
   * repo's spec dir for a `spec_id` starting with `<issue>-` and returns its
   * parsed request, else null. The issue number (not the slug) is the lookup
   * key, so a rerun reuses the spec even if the slug would differ on regen.
   *
   * @throws if a matching dir exists but its request/tasks are unreadable or
   *         invalid (a corrupt durable spec is loud, never silently a miss).
   */
  async resolveByIssue(repo, issueNumber) {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`resolveByIssue: issue number must be a positive integer, got ${issueNumber}`);
    }
    const repoRoot = join12(specsRoot(this.dataDir), repoKey(repo));
    let entries;
    try {
      entries = await readdir2(repoRoot);
    } catch (err) {
      if (isEnoent(err)) {
        return null;
      }
      throw err;
    }
    const prefix = `${issueNumber}-`;
    const matches = entries.filter((e) => issueOf(e) === issueNumber && e.startsWith(prefix));
    if (matches.length === 0) {
      return null;
    }
    if (matches.length > 1) {
      throw new Error(
        `resolveByIssue: multiple specs for issue #${issueNumber} in ${repo}: ${matches.join(", ")}`
      );
    }
    const specId = at(matches, 0);
    return this.read(repo, specId);
  }
  /**
   * Delete the canonical spec dir for `(repo, issueNumber)`, if one exists.
   * Called by `storeSpec` immediately before writing a spec, so a `--supersede`
   * regeneration replaces the old spec only AFTER the new one passed gate +
   * review (the old spec — and any run pointing at it — survives the whole
   * regen loop). Returns `true` when a dir was deleted, `false` when nothing
   * matched (idempotent — the fresh path matches nothing).
   *
   * @ponytail: only the canonical dataDir spec dir is removed; the in-repo
   * reviewable mirror (`docs/factory/<spec-id>/`) is left in place —
   * `store.write` overwrites it on regen. A slug-change leaves a cosmetic
   * stale mirror dir; not worth working-tree churn for this edge case.
   */
  async deleteByIssue(repo, issueNumber) {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`deleteByIssue: issue number must be a positive integer, got ${issueNumber}`);
    }
    const repoRoot = join12(specsRoot(this.dataDir), repoKey(repo));
    let entries;
    try {
      entries = await readdir2(repoRoot);
    } catch (err) {
      if (isEnoent(err)) {
        return false;
      }
      throw err;
    }
    const matches = entries.filter((e) => issueOf(e) === issueNumber);
    if (matches.length === 0) {
      return false;
    }
    for (const specId of matches) {
      await rm3(specDir(this.dataDir, repo, specId), { recursive: true, force: true });
    }
    log19.info(`deleted spec(s) for issue #${issueNumber} in ${repo}: ${matches.join(", ")}`);
    return true;
  }
  /** Read + validate the request for a known `(repo, spec_id)`. */
  async read(repo, specId) {
    const dir = specDir(this.dataDir, repo, specId);
    const tasksRaw = await readFile9(join12(dir, TASKS_FILE), "utf8");
    const tasks = parseSpecTasks(parseJson(tasksRaw, join12(dir, TASKS_FILE)));
    const meta = await this.readMeta(dir);
    return parseSpecManifest({
      spec_id: specId,
      issue_number: issueOf(specId) ?? meta.issue_number,
      slug: specId.replace(/^\d+-/, ""),
      repo,
      generated_at: meta.generated_at,
      tasks
    });
  }
  /**
   * Durably write a spec: `spec.md` + the bare `tasks.json` array. The request
   * header is persisted as a holdout so {@link read} can reconstruct
   * `generated_at` without re-running the generator.
   *
   * F-specloc — also mirrors `spec.md` + the bare `tasks.json` into the in-repo
   * reviewable copy (`<docsRoot>/factory/<spec-id>/`). The mirror is a strict
   * subset (no `spec.meta.json` holdout, no `prd.json` — the PRD is already
   * public on the issue): the holdout is a dataDir reconstruction detail, and
   * the canonical read-path never consults the mirror. Reruns still resolve by
   * issue number against the dataDir store (unchanged).
   *
   * S9 (Decision 47): `prd` is REQUIRED — the durable PRD snapshot is what the
   * traceability stage audits at finalize time (never a `gh` re-fetch: network
   * at the most expensive moment, and a possibly-edited PRD is a TOCTOU audit).
   */
  async write(request, specMd, prd) {
    const parsed = parseSpecManifest(request);
    const dir = specDir(this.dataDir, parsed.repo, parsed.spec_id);
    const tasksJson = stringifyJson(parsed.tasks);
    await atomicWriteFile(join12(dir, SPEC_MD_FILE), specMd);
    await atomicWriteFile(join12(dir, TASKS_FILE), tasksJson);
    await atomicWriteFile(join12(dir, PRD_FILE), stringifyJson(prd));
    await atomicWriteFile(
      join12(dir, META_FILE),
      stringifyJson({
        issue_number: parsed.issue_number,
        slug: parsed.slug,
        repo: parsed.repo,
        generated_at: parsed.generated_at
      })
    );
    const reviewDir = docsFactoryDir(this.docsRoot, parsed.spec_id);
    let mirrored = true;
    try {
      await atomicWriteFile(join12(reviewDir, SPEC_MD_FILE), specMd);
      await atomicWriteFile(join12(reviewDir, TASKS_FILE), tasksJson);
    } catch (err) {
      mirrored = false;
      log19.warn(
        `could not write reviewable copy to ${reviewDir} (${err instanceof Error ? err.message : String(err)}) \u2014 the canonical spec at ${dir} is unaffected; run continues`
      );
    }
    log19.info(
      `wrote spec ${parsed.spec_id} (${parsed.tasks.length} tasks) to ${dir} ` + (mirrored ? `(reviewable copy: ${reviewDir})` : `(reviewable copy SKIPPED \u2014 see warning)`)
    );
    return this.toPointer(parsed);
  }
  /** True iff the durable PRD snapshot exists for `(repo, specId)` — S9. */
  async hasPrd(repo, specId) {
    try {
      await access2(join12(specDir(this.dataDir, repo, specId), PRD_FILE));
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Read the durable PRD snapshot (S9). LOUD with the regenerate remedy when the
   * snapshot is missing — never a silent null (traceability would audit nothing).
   */
  async readPrd(repo, specId) {
    const path3 = join12(specDir(this.dataDir, repo, specId), PRD_FILE);
    let raw;
    try {
      raw = await readFile9(path3, "utf8");
    } catch (err) {
      if (isEnoent(err)) {
        throw new Error(
          `spec ${specId} has no PRD snapshot (created by an older factory version) \u2014 re-run with \`--supersede\` to regenerate the spec`
        );
      }
      throw err;
    }
    return parsePrd(parseJson(raw, path3), path3);
  }
  /** Build the run-facing {@link SpecPointer} from a request. */
  toPointer(request) {
    return {
      repo: request.repo,
      spec_id: request.spec_id,
      issue_number: request.issue_number
    };
  }
  async readMeta(dir) {
    const raw = await readFile9(join12(dir, META_FILE), "utf8");
    const parsed = parseJson(raw, join12(dir, META_FILE));
    const meta = parsed !== null && typeof parsed === "object" ? parsed : {};
    const issueNumber = typeof meta.issue_number === "number" ? meta.issue_number : 0;
    const generatedAt = typeof meta.generated_at === "string" ? meta.generated_at : "";
    if (generatedAt.length === 0) {
      throw new Error(`spec meta at ${dir} is missing generated_at`);
    }
    return { issue_number: issueNumber, generated_at: generatedAt };
  }
};
var META_FILE = "spec.meta.json";

// src/spec/agents.ts
var APEX_MODEL = "opus";
var APEX_EFFORT = "xhigh";
var GenerateResultSchema = external_exports.object({
  specMd: external_exports.string().min(1),
  slug: external_exports.string().min(1),
  tasks: SpecTasksSchema
}).strict();
function parseGenerateResult(raw) {
  return GenerateResultSchema.parse(raw);
}
function buildGenerateSpawn(prd) {
  return {
    role: "spec-generator",
    agent_type: SPEC_GENERATOR_AGENT_TYPE,
    model: APEX_MODEL,
    effort: APEX_EFFORT,
    context: {
      issue_number: prd.issue_number,
      title: prd.title,
      body: prd.body,
      labels: prd.labels
    }
  };
}
function buildReviseSpawn(prd, prior, feedback) {
  const base = buildGenerateSpawn(prd);
  return {
    ...base,
    context: {
      ...base.context,
      prior_spec_md: prior.specMd,
      prior_tasks: prior.tasks,
      review_feedback: feedback
    }
  };
}
function buildReviewSpawn(prd, generated) {
  return {
    role: "spec-reviewer",
    agent_type: SPEC_REVIEWER_AGENT_TYPE,
    model: APEX_MODEL,
    effort: APEX_EFFORT,
    context: {
      issue_number: prd.issue_number,
      prd_body: prd.body,
      spec_md: generated.specMd,
      tasks: generated.tasks
    }
  };
}

// src/spec/execution.ts
function safeRepoPath(path3) {
  return !path3.includes(String.fromCharCode(0)) && !/[\\*?[\]{}:]/.test(path3) && path3.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function executionOrder(tasks) {
  const ids = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.task_id) || ids.has(task.task_id)) {
      throw new Error(`invalid or duplicate task id: ${task.task_id}`);
    }
    if (task.files.some((file) => !safeRepoPath(file))) {
      throw new Error(`${task.task_id}: files must be exact, safe repository-relative paths`);
    }
    ids.set(task.task_id, task);
  }
  const ordered = [];
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const visit = (id) => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`dependency cycle at ${id}`);
    }
    const task = ids.get(id);
    if (!task) {
      throw new Error(`unknown dependency: ${id}`);
    }
    if (new Set(task.depends_on).size !== task.depends_on.length) {
      throw new Error(`${id}: duplicate dependencies`);
    }
    visiting.add(id);
    for (const dependency of task.depends_on) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(task);
  };
  for (const task of tasks) {
    visit(task.task_id);
  }
  const ancestors = /* @__PURE__ */ new Map();
  const owners = /* @__PURE__ */ new Map();
  for (const task of ordered) {
    const before = new Set(task.depends_on);
    for (const id of task.depends_on) {
      for (const ancestor of ancestors.get(id) ?? []) {
        before.add(ancestor);
      }
    }
    for (const file of task.files) {
      const prior = owners.get(file);
      if (prior !== void 0 && !before.has(prior)) {
        throw new Error(`${task.task_id}: shared file ${file} requires a dependency on ${prior}`);
      }
      owners.set(file, task.task_id);
    }
    ancestors.set(task.task_id, before);
  }
  const closedSlices = /* @__PURE__ */ new Set();
  let current;
  for (const task of ordered) {
    if (task.slice_id !== current) {
      if (current !== void 0) {
        closedSlices.add(current);
      }
      current = task.slice_id;
      if (current !== void 0 && closedSlices.has(current)) {
        throw new Error(`slice ${current} is interleaved; order dependencies within complete slices`);
      }
    }
  }
  return ordered;
}

// src/spec/gates.ts
function combineGates(...results) {
  const blockers = results.flatMap((r) => r.blockers);
  return { passed: blockers.length === 0, blockers };
}
var MIN_PRD_BODY_CHARS = 200;
var AC_SECTION_HEADING = /^(acceptance[ -]criteria|acceptance[ -]tests?|success[ -]criteria|definition[ -]of[ -]done)\b/i;
function specifiabilityGate(body) {
  const blockers = [];
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const content = lines.filter((l) => l.length > 0 && !/^#{1,6}\s/.test(l)).join("\n");
  if (content.length < MIN_PRD_BODY_CHARS) {
    blockers.push(
      `specifiability: PRD body is trivial (${content.length} chars of content, minimum ${MIN_PRD_BODY_CHARS}) \u2014 describe the problem, the desired behavior, and constraints`
    );
  }
  if (extractPrdRequirements(body).length === 0) {
    blockers.push(
      "specifiability: no extractable requirements \u2014 add bulleted requirements or normative (must/should) sentences outside Out-of-Scope/Non-Goals sections"
    );
  }
  const hasAcSection = lines.some((l) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(l);
    return heading !== null && AC_SECTION_HEADING.test(nonNull(heading[1]).trim());
  });
  if (!hasAcSection && !hasNestedCriteriaShape(body)) {
    blockers.push(
      'specifiability: no acceptance-criteria-shaped section and no nested per-requirement criteria \u2014 add an "## Acceptance Criteria" (or Definition of Done / Success Criteria) section, or nest testable criteria as sub-bullets under each requirement'
    );
  }
  return { passed: blockers.length === 0, blockers };
}
function hasNestedCriteriaShape(body) {
  let skipLevel = null;
  let parentIndent = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = nonNull(heading[1]).length;
      if (skipLevel !== null && level <= skipLevel) {
        skipLevel = null;
      }
      if (EXCLUDED_SECTION_HEADING.test(nonNull(heading[2]).trim())) {
        skipLevel = level;
      }
      parentIndent = null;
      continue;
    }
    if (skipLevel !== null) {
      continue;
    }
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+\S/.exec(raw);
    if (!item) {
      continue;
    }
    const indent = nonNull(item[1]).length;
    if (parentIndent !== null && indent > parentIndent) {
      return true;
    }
    parentIndent = indent;
  }
  return false;
}
var HORIZONTAL_MARKERS = [
  "schema",
  "database",
  "migration",
  "model",
  "models",
  "backend",
  "frontend",
  "ui",
  "api layer",
  "data layer",
  "service layer",
  "controllers",
  "routes",
  "styling",
  "css",
  "types",
  "interfaces",
  "tests"
];
function looksHorizontal(title) {
  const t = title.trim().toLowerCase();
  if (t.split(/\s+/).length > 4) {
    return false;
  }
  return HORIZONTAL_MARKERS.some((m) => t === m || t.startsWith(m + " ") || t.endsWith(" " + m));
}
function verticalSliceGate(tasks) {
  if (tasks.length <= 1) {
    return { passed: true, blockers: [] };
  }
  const horizontal = tasks.filter((t) => looksHorizontal(t.title));
  if (horizontal.length === tasks.length) {
    return {
      passed: false,
      blockers: [
        `vertical-slice: decomposition is purely horizontal \u2014 every task is a layer (${horizontal.map((t) => t.task_id).join(", ")}); slice by end-to-end feature instead`
      ]
    };
  }
  return { passed: true, blockers: [] };
}
var VAGUE_MARKERS = [
  "works well",
  "works correctly",
  "works properly",
  "as expected",
  "user-friendly",
  "easy to use",
  "intuitive",
  "fast enough",
  "performant",
  "good performance",
  "robust",
  "reliable",
  "handle errors gracefully",
  "looks good",
  "high quality",
  "etc.",
  "and so on"
];
function keywords(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4)
  );
}
function isVague(criterion) {
  const c = criterion.trim().toLowerCase();
  if (c.length < 8) {
    return true;
  }
  return VAGUE_MARKERS.some((m) => c.includes(m));
}
function hasCoveringTest(criterion, tests) {
  const ck = keywords(criterion);
  if (ck.size === 0) {
    return false;
  }
  return tests.some((t) => {
    const tk = keywords(t);
    for (const w of ck) {
      if (tk.has(w)) {
        return true;
      }
    }
    return false;
  });
}
function testabilityGate(tasks) {
  const blockers = [];
  for (const task of tasks) {
    for (const criterion of task.acceptance_criteria) {
      if (isVague(criterion)) {
        blockers.push(`testability: task ${task.task_id} has a vague/non-actionable criterion: "${criterion}"`);
        continue;
      }
      if (!hasCoveringTest(criterion, task.tests_to_write)) {
        blockers.push(
          `testability: task ${task.task_id} criterion "${criterion}" has no covering tests_to_write entry`
        );
      }
    }
  }
  return { passed: blockers.length === 0, blockers };
}
var EXCLUDED_SECTION_HEADING = /^(out[ -]of[ -]scope|non[- ]?goals?|not doing|won'?t do)\b/i;
function extractPrdRequirements(body) {
  const reqs = [];
  let pending = [];
  let skipLevel = null;
  let fence;
  const flush = () => {
    if (pending.length > 0) {
      reqs.push(pending.join(" "));
      pending = [];
    }
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const fenceMarker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== void 0) {
      if (fenceMarker?.startsWith(fence) === true) {
        fence = void 0;
      }
      continue;
    }
    if (fenceMarker !== void 0) {
      fence = fenceMarker;
      continue;
    }
    if (line.length === 0) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = nonNull(heading[1]).length;
      if (skipLevel !== null && level <= skipLevel) {
        skipLevel = null;
      }
      if (EXCLUDED_SECTION_HEADING.test(nonNull(heading[2]).trim())) {
        skipLevel = level;
      }
      continue;
    }
    if (skipLevel !== null) {
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)]|R\d+[.):])\s+(.*)$/i.exec(line)?.[1];
    if (item !== void 0) {
      flush();
      pending.push(item.trim());
    } else if (/\b(must|shall|should|need to|required to)\b/i.test(line)) {
      flush();
      pending.push(line);
    } else if (pending.length > 0) {
      pending.push(line);
    }
  }
  flush();
  return reqs;
}
function requirementCovered(requirement, allCriteria) {
  const rk = keywords(requirement);
  if (rk.size === 0) {
    return true;
  }
  return allCriteria.some((c) => {
    const ck = keywords(c);
    let shared = 0;
    for (const w of rk) {
      if (ck.has(w)) {
        shared++;
      }
    }
    return shared >= Math.min(2, rk.size);
  });
}
function taskLaddersToPrd(task, requirements) {
  const text = [task.title, task.description, ...task.acceptance_criteria].join(" ");
  const tk = keywords(text);
  if (requirements.length === 0) {
    return false;
  }
  return requirements.some((r) => {
    const rk = keywords(r);
    for (const w of rk) {
      if (tk.has(w)) {
        return true;
      }
    }
    return false;
  });
}
function traceabilityGate(prd, tasks) {
  const requirements = extractPrdRequirements(prd.body);
  const allCriteria = tasks.flatMap((t) => t.acceptance_criteria);
  const blockers = [];
  if (requirements.length === 0) {
    blockers.push(
      `traceability: PRD #${prd.issue_number} yielded no extractable requirements \u2014 cannot verify the spec covers it (PRD is the axiom)`
    );
    return { passed: false, blockers };
  }
  for (const req of requirements) {
    if (!requirementCovered(req, allCriteria)) {
      blockers.push(`traceability: PRD requirement has no covering acceptance criterion: "${req}"`);
    }
  }
  for (const task of tasks) {
    if (!taskLaddersToPrd(task, requirements)) {
      blockers.push(`traceability: task ${task.task_id} ("${task.title}") does not ladder to any PRD requirement`);
    }
  }
  return { passed: blockers.length === 0, blockers };
}
function runSpecGates(prd, tasks) {
  const structural = { passed: true, blockers: [] };
  try {
    executionOrder(tasks);
  } catch (error) {
    structural.passed = false;
    structural.blockers.push(error instanceof Error ? error.message : String(error));
  }
  return combineGates(structural, verticalSliceGate(tasks), testabilityGate(tasks), traceabilityGate(prd, tasks));
}

// src/spec/review.ts
var REVIEW_DIMENSION_COUNT = 6;
var REVIEW_MAX_TOTAL = REVIEW_DIMENSION_COUNT * 10;
var dimScore = external_exports.number().int().min(1).max(10);
var PerDimensionSchema = external_exports.object({
  granularity: dimScore,
  dependencies: dimScore,
  acceptance_criteria: dimScore,
  tests: dimScore,
  vertical_slices: dimScore,
  alignment: dimScore
}).strict();
var ReviewVerdictSchema = external_exports.object({
  decision: external_exports.enum(["PASS", "NEEDS_REVISION"]),
  score: external_exports.number().int().min(0).max(REVIEW_MAX_TOTAL),
  per_dimension: PerDimensionSchema,
  blockers: external_exports.array(external_exports.string()).default([]),
  concerns: external_exports.array(external_exports.string()).default([])
}).strict();
function parseReviewVerdict(raw) {
  return ReviewVerdictSchema.parse(raw);
}
function decideSpecReview(verdict, opts = {}) {
  const threshold = opts.passReviewThreshold ?? SPEC_DEFAULTS.passReviewThreshold;
  const floor = opts.dimensionFloor ?? SPEC_DEFAULTS.dimensionFloor;
  const dims = verdict.per_dimension;
  const total = dims.granularity + dims.dependencies + dims.acceptance_criteria + dims.tests + dims.vertical_slices + dims.alignment;
  const floorFailures = Object.entries(dims).filter(([, v]) => v <= floor).map(([k]) => k);
  if (floorFailures.length > 0) {
    return {
      decision: "NEEDS_REVISION",
      total,
      floorFailures,
      reason: `auto-fail floor tripped: dimension(s) ${floorFailures.join(", ")} scored <= ${floor} (total ${total}/${REVIEW_MAX_TOTAL})`
    };
  }
  if (total >= threshold) {
    return {
      decision: "PASS",
      total,
      floorFailures: [],
      reason: `total ${total}/${REVIEW_MAX_TOTAL} >= threshold ${threshold}`
    };
  }
  return {
    decision: "NEEDS_REVISION",
    total,
    floorFailures: [],
    reason: `total ${total}/${REVIEW_MAX_TOTAL} < threshold ${threshold}`
  };
}

// src/spec/build.ts
import { join as join13 } from "node:path";
import { readFile as readFile10 } from "node:fs/promises";

// src/feature/schema.ts
import { createHash as createHash2 } from "node:crypto";
var VERSION = 2;
var REPAIR_PASSES = 3;
var IdSchema = external_exports.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
var ShaSchema = external_exports.string().regex(/^[a-f0-9]{40,64}$/);
var FeatureTaskSchema = SpecTaskSchema.extend({
  slice_id: IdSchema,
  requirement_ids: external_exports.array(IdSchema).min(1)
});
var FeatureSpecSchema = external_exports.object({
  version: external_exports.literal(VERSION),
  revision: external_exports.number().int().positive(),
  base_sha: ShaSchema,
  prd: PrdSchema,
  spec_md: external_exports.string().min(1),
  contracts: external_exports.record(external_exports.string()),
  tasks: external_exports.array(FeatureTaskSchema).min(1)
}).strict();
function digest(value) {
  return createHash2("sha256").update(JSON.stringify(value)).digest("hex");
}
function validateFeatureSpec(raw) {
  const spec = FeatureSpecSchema.parse(raw);
  spec.tasks = executionOrder(spec.tasks);
  const requirements = extractPrdRequirements(spec.prd.body).map((text, index) => ({ id: `R${index + 1}`, text }));
  if (requirements.length === 0) {
    throw new Error("PRD has no requirements");
  }
  const ids = new Set(requirements.map((row) => row.id));
  const covered = /* @__PURE__ */ new Set();
  for (const task of spec.tasks) {
    for (const id of task.requirement_ids) {
      if (!ids.has(id)) {
        throw new Error(`${task.task_id}: unknown requirement ${id}`);
      }
      covered.add(id);
    }
  }
  for (const id of ids) {
    if (!covered.has(id)) {
      throw new Error(`uncovered requirement ${id}`);
    }
  }
  return spec;
}
var StageSchema = external_exports.enum([
  "prepare",
  "tests",
  "implement",
  "task-check",
  "task-review",
  "slice-check",
  "slice-review",
  "docs",
  "e2e-author",
  "feature-check",
  "feature-review",
  "acceptance",
  "confirm",
  "spec-repair",
  "spec-review",
  "deliver"
]);
var ClaimSchema = external_exports.object({
  id: IdSchema,
  reviewer: external_exports.string().min(1),
  severity: external_exports.enum(["important", "critical"]),
  file: external_exports.string().min(1),
  line: external_exports.number().int().positive(),
  quote: external_exports.string().min(10),
  claim: external_exports.string().min(1).max(300)
});
var AttemptSchema = external_exports.object({
  id: IdSchema,
  driver: external_exports.string().min(1),
  stage: StageSchema,
  base_sha: ShaSchema,
  head_sha: ShaSchema,
  spec_digest: external_exports.string(),
  worktree: external_exports.string(),
  roles: external_exports.array(external_exports.string()),
  issued_at: external_exports.string()
});
var FeatureRunSchema = external_exports.object({
  version: external_exports.literal(VERSION),
  run_id: IdSchema,
  repo: external_exports.string().min(1),
  root: external_exports.string(),
  branch: external_exports.string(),
  worktree: external_exports.string(),
  base_branch: external_exports.string(),
  remote: external_exports.string(),
  ship_mode: external_exports.enum(["live", "no-ship"]),
  debug: external_exports.boolean(),
  e2e: external_exports.boolean(),
  ignore_quota: external_exports.boolean(),
  owner_session: external_exports.string().optional(),
  spec: FeatureSpecSchema,
  spec_digest: external_exports.string(),
  status: external_exports.enum([
    "running",
    "parked",
    "waiting",
    "awaiting-merge",
    "ready-for-review",
    "completed",
    "cancelled"
  ]),
  wait_since: external_exports.string().optional(),
  stop_reason: external_exports.object({
    kind: external_exports.enum(["operator", "quota", "ci", "environment", "producer", "spec", "context"]),
    message: external_exports.string()
  }).optional(),
  stage: StageSchema,
  task_index: external_exports.number().int().min(0),
  accepted_sha: ShaSchema,
  verified_feature: external_exports.object({ head_sha: ShaSchema, spec_digest: external_exports.string() }).optional(),
  task_base_sha: ShaSchema,
  slice_base_sha: ShaSchema,
  attempts: external_exports.record(external_exports.number().int().min(0)),
  in_flight: AttemptSchema.optional(),
  checkpoints: external_exports.array(external_exports.object({ task_id: IdSchema, head_sha: ShaSchema, spec_digest: external_exports.string() })),
  answers: external_exports.array(external_exports.object({ task_id: IdSchema, question: external_exports.string(), answer: external_exports.string(), at: external_exports.string() })),
  question: external_exports.string().optional(),
  feedback: external_exports.array(external_exports.string()),
  claims: external_exports.array(ClaimSchema),
  after_confirm: StageSchema.optional(),
  candidate_satisfied: external_exports.boolean(),
  repaired_spec: FeatureSpecSchema.optional(),
  delivery: external_exports.object({
    pr_number: external_exports.number().int().positive().optional(),
    head_sha: ShaSchema.optional(),
    url: external_exports.string().optional(),
    outcome: external_exports.enum(["merged", "no-change", "review"]).optional()
  }),
  audit: external_exports.array(
    external_exports.object({ at: external_exports.string(), event: external_exports.string(), stage: StageSchema, head_sha: ShaSchema, details: external_exports.unknown() })
  )
}).strict();
function terminal(run5) {
  return ["completed", "ready-for-review", "cancelled"].includes(run5.status);
}
var ResultSchema = external_exports.object({
  attempt_id: IdSchema,
  spec_digest: external_exports.string(),
  head_sha: ShaSchema,
  status: external_exports.enum(["done", "already-satisfied", "needs-context", "spec-defect", "blocked"]),
  message: external_exports.string().optional(),
  reviews: external_exports.array(external_exports.object({ reviewer: external_exports.string(), claims: external_exports.array(ClaimSchema) })).optional(),
  confirmations: external_exports.array(external_exports.object({ id: IdSchema, confirmed: external_exports.boolean(), evidence: external_exports.string().min(10) })).optional(),
  acceptance: external_exports.array(external_exports.object({ id: external_exports.string(), met: external_exports.boolean(), evidence: external_exports.string().min(10) })).optional(),
  repaired_spec: FeatureSpecSchema.optional()
}).strict();

// src/spec/build.ts
var PRD_FILE2 = "prd.json";
var GENERATED_FILE = "generated.json";
var VERDICT_FILE = "verdict.json";
var ATTEMPTS_FILE = "attempts.json";
async function withRepositoryContext(spawn3, deps, repo, issue, prd) {
  if (!deps.snapshot) {
    return spawn3;
  }
  const snapshot = await readJsonFile(
    join13(specBuildDir(deps.scratchRoot, repo, issue), "context.json")
  );
  return {
    ...spawn3,
    context: {
      ...spawn3.context,
      repository_snapshot: snapshot,
      requirements: extractPrdRequirements(prd.body).map((text, index) => ({ id: `R${index + 1}`, text }))
    }
  };
}
function scratchPaths(scratchRoot, repo, issue) {
  const dir = specBuildDir(scratchRoot, repo, issue);
  return {
    prdPath: join13(dir, PRD_FILE2),
    generatedPath: join13(dir, GENERATED_FILE),
    verdictPath: join13(dir, VERDICT_FILE),
    attemptsPath: join13(dir, ATTEMPTS_FILE)
  };
}
async function readAttempts(attemptsPath) {
  try {
    const raw = await readJsonFile(attemptsPath);
    const n = raw.iterations;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
async function consumeRegenOrDefect(deps, repo, issue, { source, blockers }) {
  const { attemptsPath } = scratchPaths(deps.scratchRoot, repo, issue);
  const max = deps.config.spec.maxRegenIterations;
  const prior = await readAttempts(attemptsPath);
  if (prior >= max) {
    const stage = source === "gate" ? "the deterministic gates" : "review";
    return {
      kind: "spec-defect",
      repo,
      issue,
      source,
      iterations: prior,
      max_iterations: max,
      reason: `spec regeneration bound exhausted (${prior}/${max}) \u2014 the spec never passed ${stage}; the PRD likely needs rework`,
      blockers
    };
  }
  await atomicWriteFile(attemptsPath, stringifyJson({ iterations: prior + 1 }));
  return null;
}
async function quotaPause(deps, repo, issue, ignoreQuota) {
  if (ignoreQuota) {
    return null;
  }
  const decision = evaluate(await deps.usage.read(), deps.config, deps.now());
  if (decision.kind === "proceed") {
    return null;
  }
  return {
    kind: "pause",
    repo,
    issue,
    scope: decision.kind === "pause-5h" ? "5h" : decision.kind === "suspend-7d" ? "7d" : "unavailable",
    reason: decision.reason,
    ...decision.kind === "unavailable-halt" ? {} : { resets_at_epoch: decision.resetsAtEpoch }
  };
}
async function resolveSpec(deps, repo, issue, { regenerate = false, ignoreQuota = false } = {}) {
  if (!regenerate && deps.snapshot === void 0) {
    const existing = await deps.store.resolveByIssue(repo, issue);
    if (existing) {
      return { kind: "reuse", repo, issue, pointer: deps.store.toPointer(existing) };
    }
  }
  const prd = await deps.gh.fetchPrd(issue, { repo });
  const { prdPath, generatedPath, attemptsPath } = scratchPaths(deps.scratchRoot, repo, issue);
  await atomicWriteFile(prdPath, stringifyJson(prd));
  if (deps.snapshot) {
    await atomicWriteFile(
      join13(specBuildDir(deps.scratchRoot, repo, issue), "context.json"),
      stringifyJson(await deps.snapshot())
    );
  }
  const specifiability = specifiabilityGate(prd.body);
  if (!specifiability.passed) {
    return {
      kind: "unspecifiable",
      repo,
      issue,
      prd_path: prdPath,
      blockers: specifiability.blockers
    };
  }
  const pause = await quotaPause(deps, repo, issue, ignoreQuota);
  if (pause) {
    return pause;
  }
  await atomicWriteFile(attemptsPath, stringifyJson({ iterations: 0 }));
  return {
    kind: "generate",
    repo,
    issue,
    spawn: await withRepositoryContext(buildGenerateSpawn(prd), deps, repo, issue, prd),
    prd_path: prdPath,
    generated_path: generatedPath,
    max_iterations: deps.config.spec.maxRegenIterations
  };
}
async function gateSpec(deps, repo, issue) {
  const { prdPath, generatedPath, verdictPath } = scratchPaths(deps.scratchRoot, repo, issue);
  const prd = await readJsonFile(prdPath);
  const raw = await readFile10(generatedPath, "utf8");
  let generated;
  try {
    generated = parseGenerateResult(JSON.parse(raw));
  } catch (error) {
    if (!(error instanceof external_exports.ZodError || error instanceof SyntaxError)) {
      throw error;
    }
    const blockers = [`Invalid generated output: ${error.message}`];
    const defect = await consumeRegenOrDefect(deps, repo, issue, { source: "gate", blockers });
    if (defect) {
      return defect;
    }
    return {
      kind: "revise",
      repo,
      issue,
      source: "gate",
      reason: `Invalid generated output: ${error.message}`,
      blockers,
      spawn: await withRepositoryContext(
        buildReviseSpawn(
          prd,
          { specMd: `Invalid prior JSON (repair its structure):
${raw}`, slug: "repair", tasks: [] },
          blockers
        ),
        deps,
        repo,
        issue,
        prd
      ),
      generated_path: generatedPath
    };
  }
  const gates = runSpecGates(prd, generated.tasks);
  if (deps.snapshot) {
    try {
      const snapshot = await readJsonFile(
        join13(specBuildDir(deps.scratchRoot, repo, issue), "context.json")
      );
      validateFeatureSpec({
        version: 2,
        revision: 1,
        ...snapshot,
        prd,
        spec_md: generated.specMd,
        tasks: generated.tasks
      });
    } catch (error) {
      gates.passed = false;
      gates.blockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!gates.passed) {
    const defect = await consumeRegenOrDefect(deps, repo, issue, { source: "gate", blockers: gates.blockers });
    if (defect) {
      return defect;
    }
    return {
      kind: "revise",
      repo,
      issue,
      source: "gate",
      reason: "deterministic spec gates blocked the spec",
      blockers: gates.blockers,
      // review_feedback derives from these same blockers — single source, no divergence.
      spawn: await withRepositoryContext(
        buildReviseSpawn(prd, generated, gates.blockers),
        deps,
        repo,
        issue,
        prd
      ),
      generated_path: generatedPath
    };
  }
  await atomicWriteFile(
    join13(specBuildDir(deps.scratchRoot, repo, issue), "review-input-digest.json"),
    stringifyJson(digest(generated))
  );
  return {
    kind: "review",
    repo,
    issue,
    spawn: await withRepositoryContext(buildReviewSpawn(prd, generated), deps, repo, issue, prd),
    generated_path: generatedPath,
    verdict_path: verdictPath
  };
}
async function storeSpec(deps, repo, issue) {
  const { prdPath, generatedPath, verdictPath } = scratchPaths(deps.scratchRoot, repo, issue);
  const generated = parseGenerateResult(await readJsonFile(generatedPath));
  const verdict = parseReviewVerdict(await readJsonFile(verdictPath));
  if (deps.snapshot) {
    const expected = await readJsonFile(
      join13(specBuildDir(deps.scratchRoot, repo, issue), "review-input-digest.json")
    );
    if (expected !== digest(generated)) {
      throw new Error("spec changed after review was requested; gate and review again");
    }
  }
  const decision = decideSpecReview(verdict, {
    passReviewThreshold: deps.config.spec.passReviewThreshold,
    dimensionFloor: deps.config.spec.dimensionFloor
  });
  if (decision.decision === "NEEDS_REVISION") {
    const blockers = verdict.blockers.length > 0 ? verdict.blockers : [decision.reason];
    const defect = await consumeRegenOrDefect(deps, repo, issue, { source: "review", blockers });
    if (defect) {
      return defect;
    }
    const prd2 = await readJsonFile(prdPath);
    return {
      kind: "revise",
      repo,
      issue,
      source: "review",
      reason: decision.reason,
      blockers,
      spawn: await withRepositoryContext(buildReviseSpawn(prd2, generated, blockers), deps, repo, issue, prd2),
      generated_path: generatedPath
    };
  }
  const request = buildManifest(repo, issue, generated);
  const prd = await readJsonFile(prdPath);
  await deps.store.deleteByIssue(repo, issue);
  const pointer = await deps.store.write(request, generated.specMd, prd);
  if (deps.snapshot && deps.featureDataDir !== void 0) {
    const snapshot = await readJsonFile(
      join13(specBuildDir(deps.scratchRoot, repo, issue), "context.json")
    );
    const feature = validateFeatureSpec({
      version: 2,
      revision: 1,
      ...snapshot,
      prd,
      spec_md: generated.specMd,
      tasks: generated.tasks
    });
    await atomicWriteFile(
      join13(specDir(deps.featureDataDir, repo, request.spec_id), "feature.json"),
      stringifyJson(feature)
    );
  }
  return { kind: "stored", repo, issue, pointer };
}
function buildManifest(repo, issueNumber, generated) {
  const specId = makeSpecId(issueNumber, generated.slug);
  const slug = specId.replace(/^\d+-/, "");
  return parseSpecManifest({
    spec_id: specId,
    issue_number: issueNumber,
    slug,
    repo,
    generated_at: nowIso(),
    tasks: generated.tasks
  });
}

// src/cli/subcommands/spec.ts
var SPEC_HELP = `factory spec \u2014 deterministic spec-build seam (resolve \u2192 gate \u2192 store)

Usage:
  factory spec resolve [--repo <owner/name>] --issue <n> [--supersede] [--ignore-quota]
  factory spec gate    [--repo <owner/name>] --issue <n>
  factory spec store   [--repo <owner/name>] --issue <n>

--repo is OPTIONAL: auto-derived from the 'origin' remote when omitted; an explicit
value that disagrees with the remote fails loud.

The in-session runner drives the agent spawns; the ENGINE bounds the regen loop
(scratch attempts.json; over spec.maxRegenIterations \u2192 terminal spec-defect, exit 1)
and quota-gates resolve (pause envelope; --ignore-quota overrides). Each action emits
ONE JSON envelope naming the next step. Scratch JSON is threaded through the OS temp
dir, factory-spec-build/<repo>/<issue>/{prd,generated,verdict,attempts}.json
(transient pre-validation agent output, never the plugin data dir).

Actions:
  resolve  Reuse an existing spec by issue, else fetch the PRD + emit the generate spawn.
  gate     Run the deterministic spec gates; emit revise (blockers) or the review spawn.
  store    Adjudicate the review (56/60 + floor); emit revise or persist + emit the pointer.`;
function parseIssue(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--issue must be a positive integer, got '${raw}'`);
  }
  return n;
}
function wireDeps() {
  const dataDir = resolveDataDir({});
  const config = loadConfig({ dataDir });
  const featureDataDir = join14(dataDir, "v2");
  return {
    store: new SpecStore({ dataDir: featureDataDir }),
    featureDataDir,
    snapshot: () => repositorySnapshot(process.cwd(), config),
    gh: new RealGhClient({ bodyMaxBytes: config.spec.prdBodyMaxBytes }),
    config,
    usage: new StatuslineUsageSignal({ dataDir }),
    now: nowEpoch,
    scratchRoot: defaultSpecBuildRoot()
  };
}
var ACTIONS = {
  resolve: resolveSpec,
  gate: gateSpec,
  store: storeSpec
};
async function resolveSpecRepo(args, overrides = {}) {
  return resolveRepo({
    explicit: optionalString(args.flag("repo")),
    cwd: overrides.cwd ?? process.cwd(),
    gitClient: overrides.gitClient ?? new DefaultGitClient()
  });
}
async function run3(argv) {
  const action = argv[0];
  if (action === void 0 || action === "--help" || action === "-h") {
    emitLine(SPEC_HELP);
    return EXIT.OK;
  }
  const handler = ACTIONS[action];
  if (handler === void 0) {
    throw new UsageError(`unknown spec action '${action}' (expected resolve | gate | store)`);
  }
  const args = parseArgs(argv.slice(1), { booleans: ["supersede", "ignore-quota"] });
  if (args.flag("help") === true) {
    return emitHelp(SPEC_HELP);
  }
  const issue = parseIssue(args.requireFlag("issue"));
  const repo = await resolveSpecRepo(args);
  const supersede = args.flag("supersede") === true;
  const ignoreQuota = args.flag("ignore-quota") === true;
  const deps = wireDeps();
  const envelope = action === "resolve" ? await resolveSpec(deps, repo, issue, { regenerate: supersede, ignoreQuota }) : await handler(deps, repo, issue);
  emitJson(envelope);
  if (envelope.kind === "unspecifiable") {
    emitError(
      `PRD #${issue} is not specifiable \u2014 fix the PRD and re-run:
` + envelope.blockers.map((b) => `  - ${b}`).join("\n")
    );
  }
  if (envelope.kind === "spec-defect") {
    emitError(
      `spec regeneration bound exhausted for #${issue} (${envelope.iterations}/${envelope.max_iterations}) \u2014 rework the PRD (or raise spec.maxRegenIterations) and re-run; latest blockers:
` + envelope.blockers.map((b) => `  - ${b}`).join("\n")
    );
  }
  return specExitCode(envelope);
}
function specExitCode(envelope) {
  return envelope.kind === "unspecifiable" || envelope.kind === "spec-defect" ? EXIT.ERROR : EXIT.OK;
}
var specCommand = {
  describe: "Build a durable spec (resolve \u2192 gate \u2192 store; runner drives the agent spawns)",
  run: withUsageGuard("spec", run3)
};

// src/feature/cli.ts
import { readFile as readFile13 } from "node:fs/promises";
import { join as join18 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";

// src/feature/engine.ts
import { randomUUID } from "node:crypto";
import { join as join16 } from "node:path";

// src/feature/store.ts
import { readFile as readFile11, readdir as readdir3 } from "node:fs/promises";
import { join as join15 } from "node:path";
var FeatureStore = class {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  dir(id) {
    return join15(this.dataDir, "runs-v2", IdSchema.parse(id));
  }
  async read(id) {
    let raw;
    try {
      raw = JSON.parse(await readFile11(join15(this.dir(id), "state.json"), "utf8"));
    } catch (error) {
      if (isEnoent(error)) {
        throw new Error(
          `run ${id} is missing or uses an unsupported version; start a fresh v2 run (legacy artifacts are preserved)`
        );
      }
      throw error;
    }
    const run5 = FeatureRunSchema.parse(raw);
    if (run5.run_id !== id || digest(run5.spec) !== run5.spec_digest) {
      throw new Error(`run ${id}: corrupt identity or spec snapshot`);
    }
    return run5;
  }
  async list() {
    let names;
    try {
      names = await readdir3(join15(this.dataDir, "runs-v2"));
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
    return Promise.all(names.filter((name) => IdSchema.safeParse(name).success).map((name) => this.read(name)));
  }
  async write(run5) {
    const checked = FeatureRunSchema.parse(run5);
    if (digest(checked.spec) !== checked.spec_digest) {
      throw new Error("spec snapshot digest mismatch");
    }
    const dir = this.dir(run5.run_id);
    await atomicWriteFile(join15(dir, "state.json"), JSON.stringify(checked, null, 2) + "\n");
    await atomicWriteFile(join15(dir, "ledger.md"), renderLedger(checked));
  }
  async withRepo(repo, fn) {
    const dir = join15(this.dataDir, "locks-v2");
    return withFileLock(
      {
        dir,
        lockfile: join15(dir, digest(repo)),
        label: repo,
        dirPolicy: "create",
        tuning: DEFAULT_FILE_LOCK_TUNING
      },
      fn
    );
  }
  async recordResult(id, result) {
    const checked = ResultSchema.parse(result);
    await atomicWriteFile(join15(this.dir(id), "results", `${checked.attempt_id}.json`), JSON.stringify(checked));
  }
  async result(id, attemptId) {
    try {
      return ResultSchema.parse(
        JSON.parse(await readFile11(join15(this.dir(id), "results", `${IdSchema.parse(attemptId)}.json`), "utf8"))
      );
    } catch (error) {
      if (isEnoent(error)) {
        return void 0;
      }
      throw error;
    }
  }
};
function renderLedger(run5) {
  return [
    `# Feature ${run5.run_id}`,
    "",
    `Status: ${run5.status}. Resume: ${run5.stage}, task ${run5.task_index + 1}.`,
    `Branch: ${run5.branch}. Accepted HEAD: ${run5.accepted_sha}. Spec: ${run5.spec_digest}.`,
    run5.stop_reason ? `Stopped: ${run5.stop_reason.kind}: ${run5.stop_reason.message}` : "",
    "",
    "## Accepted tasks",
    "",
    ...run5.checkpoints.map((row) => `- ${row.task_id}: ${row.head_sha}`),
    "",
    "## Answers",
    "",
    ...run5.answers.map((row) => `- ${row.task_id}: ${row.question}
  Answer: ${row.answer}`),
    "",
    "## Audit",
    "",
    ...run5.audit.map(
      (row) => `- ${row.at} ${row.stage}: ${row.event} (${row.head_sha})
  ${JSON.stringify(row.details)}`
    ),
    ""
  ].join("\n");
}

// src/feature/engine.ts
var PANEL = ["quality-reviewer", "implementation-reviewer", "silent-failure-hunter", "systemic-failure-reviewer"];
var PRODUCERS = ["tests", "implement", "docs", "e2e-author", "spec-repair"];
var FeatureEngine = class {
  constructor(store, runtime) {
    this.store = store;
    this.runtime = runtime;
  }
  async create(input) {
    return this.store.withRepo(input.repo, async () => {
      const id = IdSchema.parse(input.runId);
      const spec = validateFeatureSpec(input.spec);
      const runs = await this.store.list();
      if (runs.some((run6) => run6.run_id === id)) {
        throw new Error(`run ${id} already exists`);
      }
      const active = runs.find((run6) => run6.repo === input.repo && !terminal(run6));
      if (active) {
        throw new Error(`repository already has active run ${active.run_id}; resume or cancel it`);
      }
      const run5 = {
        version: VERSION,
        run_id: id,
        repo: input.repo,
        root: input.root,
        branch: `factory/${spec.prd.issue_number}-${id}`,
        worktree: join16(input.root, ".claude", "worktrees", `feature-${id}`),
        base_branch: input.baseBranch,
        remote: input.remote,
        ship_mode: input.shipMode ?? "live",
        ignore_quota: input.ignoreQuota ?? false,
        debug: input.debug ?? false,
        e2e: input.e2e ?? false,
        ...input.ownerSession !== void 0 && input.ownerSession !== "" ? { owner_session: input.ownerSession } : {},
        spec,
        spec_digest: digest(spec),
        status: "running",
        stage: "prepare",
        task_index: 0,
        accepted_sha: input.startSha ?? spec.base_sha,
        task_base_sha: spec.base_sha,
        slice_base_sha: spec.base_sha,
        attempts: {},
        checkpoints: [],
        answers: [],
        feedback: [],
        claims: [],
        candidate_satisfied: false,
        delivery: {},
        audit: []
      };
      this.audit(run5, "created", { base_sha: spec.base_sha });
      await this.store.write(run5);
      return run5;
    });
  }
  async advance(id, driver, rawResult) {
    if (!driver.trim()) {
      throw new Error("next-action requires a driver session identity");
    }
    const initial = await this.store.read(id);
    return this.store.withRepo(initial.repo, async () => {
      let run5 = await this.store.read(id);
      if (terminal(run5)) {
        if (rawResult !== void 0) {
          throw new Error("stale result for terminal run");
        }
        return this.terminal(run5);
      }
      if (run5.status === "parked") {
        return this.parked(run5);
      }
      try {
        if (rawResult !== void 0) {
          const result = ResultSchema.parse(rawResult);
          this.assertResult(run5, driver, result);
          await this.store.recordResult(id, result);
        }
        if (run5.in_flight) {
          const result = await this.store.result(id, run5.in_flight.id);
          if (!result) {
            return this.wait(run5, `awaiting ${run5.in_flight.id}; do not spawn it twice`);
          }
          this.assertResult(run5, driver, result);
          const recorded = structuredClone(run5);
          await this.record(recorded, result);
          run5 = recorded;
          await this.store.write(run5);
          if (run5.status === "parked") {
            return this.parked(run5);
          }
        }
        const quota = run5.ignore_quota ? void 0 : await this.runtime.quota(run5);
        if (quota !== void 0) {
          run5.status = "waiting";
          run5.stop_reason = { kind: "quota", message: quota };
          await this.store.write(run5);
          return this.wait(run5, quota);
        }
        run5.status = "running";
        delete run5.stop_reason;
        for (let step = 0; step < 12; step++) {
          const action = await this.step(run5, driver);
          await this.store.write(run5);
          if (action) {
            return action;
          }
        }
        return this.wait(run5, "checkpoint saved; advance again");
      } catch (error) {
        if (rawResult !== void 0) {
          throw error;
        }
        this.park(run5, "environment", error instanceof Error ? error.message : String(error));
        await this.store.write(run5);
        return this.parked(run5);
      }
    });
  }
  async stop(id) {
    return this.mutate(id, (run5) => {
      if (terminal(run5)) {
        throw new Error("terminal run cannot be stopped");
      }
      this.park(run5, "operator", "Explicit stop; resume is required even after quota recovery");
      return run5;
    });
  }
  async resume(id, options = {}) {
    return this.mutate(id, async (initial) => {
      let run5 = initial;
      if (terminal(run5)) {
        throw new Error("terminal run requires a fresh run");
      }
      if (options.cancel === true) {
        run5.status = "cancelled";
        this.audit(run5, "cancelled; branch and work preserved", {});
        return;
      }
      if (options.answer !== void 0) {
        if (run5.question === void 0 || !options.answer.trim()) {
          throw new Error("answer requires a pending question and nonempty text");
        }
        const task = this.task(run5);
        run5.answers.push({
          task_id: task.task_id,
          question: run5.question,
          answer: options.answer,
          at: this.runtime.now()
        });
        delete run5.question;
      } else if (run5.question !== void 0) {
        throw new Error(`answer required: ${run5.question}`);
      }
      if (run5.in_flight) {
        if (options.recover !== true) {
          throw new Error("attempt still leased; stop its agent, then resume --recover");
        }
        const journaled = await this.store.result(id, run5.in_flight.id);
        if (journaled !== void 0) {
          const recovered = structuredClone(run5);
          recovered.status = "running";
          delete recovered.stop_reason;
          try {
            this.assertResult(recovered, run5.in_flight.driver, journaled);
            await this.record(recovered, journaled);
            run5 = recovered;
            this.audit(run5, "durable result recovered", journaled.attempt_id);
            if (run5.status === "parked") {
              return run5;
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.audit(run5, "invalid durable result retired; evidence and work retained", {
              attempt: run5.in_flight,
              reason
            });
            run5.feedback = [...run5.feedback, `Previous result rejected: ${reason}`];
            delete run5.in_flight;
          }
        } else {
          this.audit(run5, "interrupted attempt retired; work retained", run5.in_flight);
          delete run5.in_flight;
        }
      }
      run5.status = "running";
      delete run5.stop_reason;
      delete run5.wait_since;
      this.audit(run5, "resumed", options);
      return run5;
    });
  }
  async mutate(id, fn) {
    const initial = await this.store.read(id);
    return this.store.withRepo(initial.repo, async () => {
      let run5 = await this.store.read(id);
      run5 = await fn(run5) ?? run5;
      await this.store.write(run5);
      return run5;
    });
  }
  assertResult(run5, driver, result) {
    const attempt = run5.in_flight;
    if (attempt?.id !== result.attempt_id || attempt.driver !== driver || result.spec_digest !== attempt.spec_digest || attempt.spec_digest !== run5.spec_digest) {
      throw new Error("stale, duplicate, or foreign-driver result; inspect the persisted attempt");
    }
  }
  task(run5) {
    const task = run5.spec.tasks[Math.min(run5.task_index, run5.spec.tasks.length - 1)];
    if (!task) {
      throw new Error("missing current task");
    }
    return task;
  }
  audit(run5, event, details) {
    run5.audit.push({ at: this.runtime.now(), event, stage: run5.stage, head_sha: run5.accepted_sha, details });
  }
  park(run5, kind, message) {
    run5.status = "parked";
    run5.stop_reason = { kind, message };
    this.audit(run5, "parked", run5.stop_reason);
  }
  parked(run5) {
    return { kind: "park", run_id: run5.run_id, reason: run5.stop_reason?.message ?? "parked" };
  }
  wait(run5, reason) {
    return { kind: "wait", run_id: run5.run_id, reason, retry_after_seconds: 60 };
  }
  terminal(run5) {
    return { kind: "terminal", run_id: run5.run_id, status: run5.status, delivery: run5.delivery };
  }
  repair(run5, boundary, feedback) {
    const scope = boundary.startsWith("slice") ? `slice:${this.task(run5).slice_id}` : boundary.startsWith("feature") || boundary === "acceptance" || boundary === "deliver" ? "feature" : boundary.startsWith("spec") ? "spec" : `task:${this.task(run5).task_id}`;
    const used = run5.attempts[scope] ?? 0;
    run5.feedback = feedback;
    if (used >= REPAIR_PASSES) {
      this.park(
        run5,
        scope === "spec" ? "spec" : "producer",
        `${scope}: ${REPAIR_PASSES} repair passes exhausted: ${feedback.join("; ")}`
      );
      return;
    }
    run5.attempts[scope] = used + 1;
    run5.after_confirm = boundary;
    run5.stage = scope === "spec" ? "spec-repair" : "implement";
    this.audit(run5, "repair scheduled", { scope, pass: used + 1, feedback });
  }
  reviewBase(run5) {
    if (run5.stage === "task-review") {
      return run5.task_base_sha;
    }
    if (run5.stage === "slice-review") {
      return run5.slice_base_sha;
    }
    return run5.spec.base_sha;
  }
  async spawn(run5, driver) {
    const id = randomUUID();
    const producer = PRODUCERS.includes(run5.stage);
    const head = await this.runtime.head(run5.worktree);
    if (!await this.runtime.ancestor(run5.worktree, run5.accepted_sha, head)) {
      throw new Error("accepted commits are missing; work preserved for inspection");
    }
    let roles;
    if (run5.stage === "task-review") {
      roles = ["quality-reviewer"];
    } else if (run5.stage === "slice-review" || run5.stage === "feature-review") {
      roles = [...PANEL];
      if (await this.runtime.databaseChanged(run5, this.reviewBase(run5))) {
        roles.push("database-design-reviewer");
      }
    } else if (run5.stage === "confirm") {
      roles = ["finding-verifier"];
    } else if (run5.stage === "acceptance") {
      roles = ["acceptance-evaluator"];
    } else if (run5.stage === "spec-review") {
      roles = ["spec-reviewer"];
    } else {
      roles = [
        run5.stage === "tests" ? "test-writer" : run5.stage === "e2e-author" ? "e2e-author" : run5.stage === "spec-repair" ? "spec-generator" : run5.stage === "docs" ? "scribe" : "implementer"
      ];
    }
    const worktree = producer ? run5.worktree : await this.runtime.snapshot(run5, id, head);
    const attempt = {
      id,
      driver,
      stage: run5.stage,
      head_sha: head,
      base_sha: this.reviewBase(run5),
      spec_digest: run5.spec_digest,
      worktree,
      roles,
      issued_at: this.runtime.now()
    };
    run5.in_flight = attempt;
    this.audit(run5, "attempt issued", attempt);
    return { kind: "execute", run_id: run5.run_id, attempt, prompt: this.prompt(run5, attempt) };
  }
  prompt(run5, attempt) {
    const task = this.task(run5);
    const context = run5.stage === "confirm" ? { claims: run5.claims } : {
      prd: run5.spec.prd,
      version: run5.spec.version,
      revision: run5.spec.revision,
      base_sha: run5.spec.base_sha,
      spec_md: run5.spec.spec_md,
      contracts: run5.spec.contracts,
      tasks: run5.spec.tasks,
      current_task: task,
      requirements: extractPrdRequirements(run5.spec.prd.body).map((text, index) => ({
        id: `R${index + 1}`,
        text
      })),
      checkpoints: run5.checkpoints,
      answers: run5.answers,
      feedback: run5.feedback,
      prior_reviews: run5.audit.filter(
        (row) => row.event === "review recorded" || row.event === "findings confirmed"
      ),
      repaired_spec: run5.repaired_spec
    };
    return [
      `Factory v2 ${attempt.stage}. Work in ${attempt.worktree}. Base ${attempt.base_sha}; HEAD ${attempt.head_sha}.`,
      "All acceptance criteria are visible. Preserve accepted commits and repair forward. Never reset, force-push, delete remote branches, or change engine state.",
      PRODUCERS.includes(attempt.stage) ? "Commit completed work with [task_id] tags; report the actual final HEAD. At the tests stage, establish a meaningful failing assertion before implementation. If the engine dispatched implementation directly, honor its baseline TDD exemption. Do not weaken tests." : "Review this immutable snapshot independently; do not edit it. Return evidence for every claim or acceptance decision.",
      'Return JSON: {attempt_id, spec_digest, head_sha, status:"done"|"already-satisfied"|"needs-context"|"spec-defect"|"blocked", message?}.',
      'For review also return reviews:[{reviewer,claims:[{id,reviewer,severity:"important"|"critical",file,line,quote,claim}]}], one row per requested reviewer; quote at least 10 exact source characters.',
      "For confirm return confirmations:[{id,confirmed,evidence}] for every claim. For acceptance return acceptance:[{id,met,evidence}] for every requested criterion.",
      `Acceptance IDs: ${this.acceptanceIds(run5).join(", ")}. Evidence must identify actual behavior, tests, and source; never infer satisfaction from ancestry or unrelated tests.`,
      "For spec-repair return repaired_spec with the next revision, unchanged PRD/base and completed tasks. For spec-review return status done only if the revised plan is feasible and preserves requirements.",
      `Identity: ${JSON.stringify({ attempt_id: attempt.id, spec_digest: attempt.spec_digest, head_sha: attempt.head_sha })}`,
      JSON.stringify(context, null, 2)
    ].join("\n\n");
  }
  acceptanceIds(run5) {
    if (run5.candidate_satisfied) {
      return this.task(run5).acceptance_criteria.map((_, index) => `${this.task(run5).task_id}:AC${index + 1}`);
    }
    return [
      ...extractPrdRequirements(run5.spec.prd.body).map((_, index) => `R${index + 1}`),
      ...run5.spec.tasks.flatMap(
        (task) => task.acceptance_criteria.map((_, index) => `${task.task_id}:AC${index + 1}`)
      )
    ];
  }
  async record(run5, result) {
    const attempt = run5.in_flight;
    if (attempt === void 0) {
      throw new Error("result has no active attempt");
    }
    const head = await this.runtime.head(run5.worktree);
    if (result.head_sha !== head || !PRODUCERS.includes(attempt.stage) && head !== attempt.head_sha) {
      throw new Error("result HEAD differs from the reviewed/produced tree");
    }
    if (!await this.runtime.ancestor(run5.worktree, run5.accepted_sha, head)) {
      throw new Error("producer removed accepted commits");
    }
    if (["done", "already-satisfied"].includes(result.status) && !await this.runtime.clean(run5.worktree)) {
      throw new Error("uncommitted work remains; preserve it and finish the attempt");
    }
    if (!PRODUCERS.includes(attempt.stage) && (await this.runtime.head(attempt.worktree) !== attempt.head_sha || !await this.runtime.clean(attempt.worktree))) {
      throw new Error("review snapshot was modified; independent evidence is invalid");
    }
    delete run5.in_flight;
    this.audit(run5, "result recorded", result);
    if (result.status === "needs-context") {
      run5.question = result.message ?? "Provide missing implementation context";
      this.park(run5, "context", run5.question);
      return;
    }
    if (result.status === "spec-defect") {
      this.repair(run5, "spec-repair", [result.message ?? "spec contradicts repository contracts"]);
      return;
    }
    if (result.status === "blocked") {
      this.park(run5, "environment", result.message ?? "agent reported a blocked environment");
      return;
    }
    if (result.status === "already-satisfied") {
      if (!["tests", "implement"].includes(run5.stage) || head !== run5.task_base_sha) {
        throw new Error("already-satisfied requires an unchanged task checkpoint");
      }
      run5.candidate_satisfied = true;
      run5.stage = "task-check";
      return;
    }
    switch (run5.stage) {
      case "tests": {
        const red = await this.runtime.checks(run5, "tests");
        if (head === run5.task_base_sha || red.observed === 0 || red.passed || !red.assertionFailure) {
          this.repair(run5, "tests", ["test-writer must commit task tests that demonstrably fail"]);
          if (run5.status !== "parked") {
            run5.stage = "tests";
          }
        } else {
          run5.stage = "implement";
        }
        break;
      }
      case "implement":
        run5.stage = run5.after_confirm?.startsWith("slice") === true ? "slice-check" : ["feature-check", "feature-review", "acceptance", "deliver"].includes(run5.after_confirm ?? "") ? "feature-check" : "task-check";
        delete run5.after_confirm;
        break;
      case "docs":
        run5.stage = run5.e2e ? "e2e-author" : "feature-check";
        break;
      case "e2e-author":
        run5.stage = "feature-check";
        break;
      case "task-review":
      case "slice-review":
      case "feature-review": {
        const reviews = result.reviews;
        if (reviews?.length !== attempt.roles.length || new Set(reviews.map((r) => r.reviewer)).size !== reviews.length || attempt.roles.some((role) => !reviews.some((r) => r.reviewer === role))) {
          throw new Error("missing or duplicate independent reviewer results");
        }
        run5.claims = [];
        for (const review of reviews) {
          for (const claim of review.claims) {
            if (claim.reviewer !== review.reviewer || !await this.runtime.citation(attempt.worktree, claim)) {
              throw new Error(`invalid citation for ${claim.id}`);
            }
            if (run5.claims.some((row) => row.id === claim.id)) {
              throw new Error("duplicate finding id");
            }
            run5.claims.push(claim);
          }
        }
        this.audit(run5, "review recorded", reviews);
        if (run5.claims.length) {
          run5.after_confirm = run5.stage;
          run5.stage = "confirm";
        } else {
          await this.reviewPassed(run5, run5.stage);
        }
        break;
      }
      case "confirm": {
        const votes = result.confirmations ?? [];
        if (votes.length !== run5.claims.length || new Set(votes.map((v) => v.id)).size !== votes.length || run5.claims.some((c) => !votes.some((v) => v.id === c.id))) {
          throw new Error("independent confirmation is incomplete");
        }
        const blockers = run5.claims.filter(
          (claim) => votes.find((vote) => vote.id === claim.id)?.confirmed === true
        );
        const boundary = run5.after_confirm;
        if (boundary === void 0) {
          throw new Error("confirmation has no review boundary");
        }
        this.audit(run5, "findings confirmed", { claims: run5.claims, votes });
        run5.claims = [];
        delete run5.after_confirm;
        if (blockers.length) {
          this.repair(
            run5,
            boundary,
            blockers.map((claim) => `${claim.file}:${claim.line}: ${claim.claim}`)
          );
        } else {
          await this.reviewPassed(run5, boundary);
        }
        break;
      }
      case "acceptance": {
        const rows = result.acceptance ?? [];
        const expected = this.acceptanceIds(run5);
        if (rows.length !== expected.length || new Set(rows.map((row) => row.id)).size !== rows.length || expected.some((id) => !rows.some((row) => row.id === id))) {
          throw new Error("acceptance evidence must cover every requested criterion exactly once");
        }
        const unmet = rows.filter((row) => !row.met);
        if (unmet.length) {
          const boundary = run5.candidate_satisfied ? "task-review" : "acceptance";
          run5.candidate_satisfied = false;
          this.repair(
            run5,
            boundary,
            unmet.map((row) => `${row.id}: ${row.evidence}`)
          );
        } else if (run5.candidate_satisfied) {
          run5.candidate_satisfied = false;
          await this.acceptTask(run5);
        } else {
          run5.verified_feature = { head_sha: head, spec_digest: run5.spec_digest };
          run5.stage = "deliver";
        }
        break;
      }
      case "spec-repair": {
        const spec = validateFeatureSpec(result.repaired_spec);
        if (spec.revision !== run5.spec.revision + 1 || digest(spec.prd) !== digest(run5.spec.prd) || digest(spec.contracts) !== digest(run5.spec.contracts) || spec.base_sha !== run5.spec.base_sha) {
          throw new Error("spec repair must preserve PRD/base and increment revision");
        }
        for (const [index, checkpoint] of run5.checkpoints.entries()) {
          if (spec.tasks[index]?.task_id !== checkpoint.task_id || digest(spec.tasks.find((t) => t.task_id === checkpoint.task_id)) !== digest(run5.spec.tasks.find((t) => t.task_id === checkpoint.task_id))) {
            throw new Error("spec repair cannot change or reorder the accepted task prefix");
          }
        }
        await this.runtime.validateRepair(run5, spec);
        run5.repaired_spec = spec;
        run5.stage = "spec-review";
        break;
      }
      case "spec-review":
        if (!run5.repaired_spec) {
          throw new Error("missing proposed spec repair");
        }
        run5.spec = run5.repaired_spec;
        run5.spec_digest = digest(run5.spec);
        delete run5.repaired_spec;
        run5.task_index = run5.checkpoints.length;
        run5.task_base_sha = head;
        run5.stage = run5.task_index >= run5.spec.tasks.length ? "docs" : "tests";
        break;
      case "prepare":
      case "task-check":
      case "slice-check":
      case "feature-check":
      case "deliver":
        throw new Error(`stage ${run5.stage} does not accept agent results`);
    }
  }
  async acceptTask(run5) {
    const head = await this.runtime.head(run5.worktree);
    const task = this.task(run5);
    run5.checkpoints.push({ task_id: task.task_id, head_sha: head, spec_digest: run5.spec_digest });
    run5.accepted_sha = head;
    const next = run5.spec.tasks[run5.task_index + 1];
    if (next?.slice_id !== task.slice_id) {
      run5.stage = "slice-check";
    } else {
      run5.task_index++;
      run5.task_base_sha = head;
      run5.stage = "tests";
    }
    this.audit(run5, "task accepted", task.task_id);
  }
  async reviewPassed(run5, boundary) {
    if (boundary === "task-review") {
      if (run5.candidate_satisfied) {
        run5.stage = "acceptance";
      } else {
        await this.acceptTask(run5);
      }
    } else if (boundary === "slice-review") {
      run5.accepted_sha = await this.runtime.head(run5.worktree);
      run5.task_index++;
      run5.task_base_sha = run5.accepted_sha;
      run5.slice_base_sha = run5.accepted_sha;
      run5.stage = run5.task_index >= run5.spec.tasks.length ? "docs" : "tests";
    } else {
      run5.stage = "acceptance";
    }
  }
  async step(run5, driver) {
    if (run5.status === "parked") {
      return this.parked(run5);
    }
    if (run5.stage === "prepare") {
      await this.runtime.prepare(run5.root, run5.worktree, run5.branch, run5.accepted_sha);
      run5.stage = run5.debug ? "feature-check" : "tests";
      return;
    }
    if (run5.stage === "tests" && await this.runtime.exempt(run5)) {
      run5.stage = "implement";
      return;
    }
    if (run5.stage === "tests" && await this.runtime.head(run5.worktree) === run5.task_base_sha) {
      const baseline = await this.runtime.checks(run5, "tests");
      this.audit(run5, "pre-test baseline checked", baseline);
      if (!baseline.passed) {
        this.park(
          run5,
          "environment",
          "baseline tests already fail; restore a green baseline before writing task tests"
        );
        return this.parked(run5);
      }
    }
    if (["task-check", "slice-check", "feature-check"].includes(run5.stage)) {
      const result = await this.runtime.checks(run5, run5.stage);
      this.audit(run5, "checks executed", result);
      if (!result.passed || result.observed === 0) {
        this.repair(
          run5,
          run5.stage,
          result.details.length ? result.details : ["checks produced no passing evidence"]
        );
      } else {
        run5.stage = run5.stage === "task-check" ? "task-review" : run5.stage === "slice-check" ? "slice-review" : "feature-review";
      }
      return;
    }
    if (run5.stage === "deliver") {
      const merged = await this.runtime.mergedDelivery(run5);
      if (merged) {
        run5.status = "completed";
        run5.delivery = { pr_number: merged.number, url: merged.url, head_sha: merged.head, outcome: "merged" };
        this.audit(run5, "merge confirmed", merged);
        return this.terminal(run5);
      }
      const reconciliation = await this.runtime.reconcileBase(run5);
      if (reconciliation === "merged") {
        delete run5.wait_since;
        run5.stage = "feature-check";
        this.audit(run5, "base integrated; full verification required", {});
        return;
      }
      if (reconciliation === "conflict") {
        this.repair(run5, "deliver", [
          "resolve the active merge conflict; preserve both accepted feature work and current base"
        ]);
        return;
      }
      const head = await this.runtime.head(run5.worktree);
      if (run5.verified_feature?.head_sha !== head || run5.verified_feature.spec_digest !== run5.spec_digest) {
        delete run5.wait_since;
        run5.stage = "feature-check";
        this.audit(run5, "delivery HEAD requires full verification", { head });
        return;
      }
      if (await this.runtime.noChanges(run5)) {
        run5.status = "completed";
        run5.delivery = { outcome: "no-change", head_sha: await this.runtime.head(run5.worktree) };
        this.audit(run5, "no-change completion", run5.delivery);
        return this.terminal(run5);
      }
      const result = await this.runtime.deliver(run5);
      run5.delivery = { pr_number: result.number, url: result.url, head_sha: result.head };
      this.audit(run5, "delivery observed", result);
      if (result.kind === "merged" || result.kind === "review") {
        run5.status = result.kind === "merged" ? "completed" : "ready-for-review";
        run5.delivery.outcome = result.kind === "merged" ? "merged" : "review";
        return this.terminal(run5);
      }
      if (result.kind === "failed") {
        this.repair(run5, "deliver", [result.reason ?? "required PR checks failed"]);
        return;
      }
      run5.status = "awaiting-merge";
      run5.wait_since ??= this.runtime.now();
      if (Date.parse(this.runtime.now()) - Date.parse(run5.wait_since) > this.runtime.ciWaitMinutes * 6e4) {
        this.park(run5, "ci", "CI/merge wait deadline reached; work preserved, resume to recheck");
        return this.parked(run5);
      }
      run5.stop_reason = { kind: "ci", message: result.reason ?? "waiting for required CI and merge" };
      return this.wait(run5, run5.stop_reason.message);
    }
    return this.spawn(run5, driver);
  }
};

// src/feature/runtime.ts
import { access as access4 } from "node:fs/promises";
import { join as join17 } from "node:path";

// src/verifier/deterministic/strategies/test.ts
function isVitestRunnable(file) {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) && !file.endsWith(".d.ts");
}
var testStrategy = {
  id: "test",
  async run(ctx) {
    const command = contractCommand(ctx.contract, "test");
    if (command !== void 0) {
      return procOutcome(
        "test",
        `contract:${command.join(" ")}`,
        await ctx.tools.command.run(command, { cwd: ctx.worktree })
      );
    }
    const base = /^[a-f0-9]{40,64}$/.test(ctx.baseRef) ? ctx.baseRef : `origin/${ctx.baseRef}`;
    const changed = await ctx.tools.git.changedFiles(base, { cwd: ctx.worktree });
    const scoped = diffScopedTestFiles(changed);
    const runnable = scoped.filter(isVitestRunnable);
    if (scoped.length > 0 && runnable.length === 0) {
      return skip("test", "no-vitest-runnable-tests-in-scope");
    }
    const result = await ctx.tools.vitest.run(runnable, { cwd: ctx.worktree });
    if (result.truncated) {
      throw new Error("test gate: vitest output truncated \u2014 refusing to judge a clipped run");
    }
    const observed = result.code === 0;
    const skipped = scoped.length - runnable.length;
    const scope = runnable.length > 0 ? `diff-scoped (${runnable.length} test file(s))` : "un-scoped";
    const detail = `vitest exit=${result.code ?? "null"} ${scope}` + (skipped > 0 ? `; ${skipped} non-vitest file(s) not executed` : "");
    if (observed) {
      return ran("test", true, detail);
    }
    const output = excerpt(result.stdout || result.stderr);
    return ran("test", false, output ? `${detail}: ${output}` : detail);
  }
};

// src/verifier/deterministic/tdd-classify.ts
function classifyCommit(files) {
  const real = files.filter((f) => f.length > 0);
  if (real.length === 0) {
    return "empty";
  }
  let kind = "test-only";
  for (const f of real) {
    if (!isTestPath(f) && !isDocsPath(f)) {
      kind = "impl";
    }
  }
  return kind;
}
function deriveTddVerdict(commits, exempt) {
  if (commits.length === 0) {
    return {
      ok: false,
      exempt: false,
      violations: [],
      note: "no commits in base..HEAD \u2014 fail-closed (implementer produced nothing)"
    };
  }
  const classed = commits.map((c) => ({
    sha: c.sha,
    kind: classifyCommit(c.files),
    tagged: c.tagged
  }));
  const hasImpl = classed.some((c) => c.kind === "impl");
  if (!hasImpl) {
    return { ok: true, exempt: false, violations: [], note: "no impl commit (tests/docs only)" };
  }
  if (exempt) {
    return { ok: true, exempt: true, violations: [], note: "task tdd_exempt" };
  }
  let seenTestOnly = false;
  const violations = [];
  for (const c of classed) {
    if (c.kind === "test-only" && c.tagged) {
      seenTestOnly = true;
    } else if (c.kind === "impl") {
      if (!c.tagged) {
        violations.push({ commit: c.sha, reason: "impl-commit-untagged" });
      } else if (!seenTestOnly) {
        violations.push({ commit: c.sha, reason: "impl-without-preceding-test" });
      }
    }
  }
  if (violations.length > 0) {
    return { ok: false, exempt: false, violations, note: "tdd ordering violation(s)" };
  }
  return { ok: true, exempt: false, violations: [], note: "test-before-impl satisfied" };
}

// src/verifier/deterministic/strategies/tdd.ts
function isSquashedHistory(commitFiles) {
  if (commitFiles.length !== 1) {
    return false;
  }
  const files = at(commitFiles, 0);
  const hasTest = files.some((f) => isTestPath(f));
  const hasImpl = files.some((f) => !isTestPath(f) && !f.endsWith(".md") && !f.startsWith("docs/"));
  return hasTest && hasImpl;
}
async function resolveBase(tools, baseRef, opts) {
  const remote = `origin/${baseRef}`;
  if (await tools.git.refExists(remote, opts)) {
    return remote;
  }
  if (await tools.git.refExists(baseRef, opts)) {
    return baseRef;
  }
  return null;
}
function verdictToOutcome(verdict) {
  const detail = verdict.violations.length > 0 ? `${verdict.note}: ${verdict.violations.map((v) => `${v.reason}@${v.commit}`).join(", ")}` : `${verdict.note}${verdict.exempt ? " (exempt)" : ""}`;
  return ran("tdd", verdict.ok, detail);
}
var tddStrategy = {
  id: "tdd",
  async run(ctx) {
    const opts = { cwd: ctx.worktree };
    const base = await resolveBase(ctx.tools, ctx.baseRef, opts);
    if (base === null) {
      return ran("tdd", false, `base_ref_not_found: origin/${ctx.baseRef} and ${ctx.baseRef}`);
    }
    const commits = await ctx.tools.git.commits(base, ctx.taskId, opts);
    if (isSquashedHistory(commits.map((c) => c.files))) {
      const verdict2 = {
        ok: true,
        exempt: false,
        violations: [],
        note: "squashed history \u2014 TDD gate no-op"
      };
      return verdictToOutcome(verdict2);
    }
    const exempt = ctx.exemptReader ? await ctx.exemptReader.isExempt(ctx.taskId) : false;
    const verdict = deriveTddVerdict(commits, exempt);
    return verdictToOutcome(verdict);
  }
};

// src/verifier/deterministic/strategies/coverage.ts
var METRICS = ["lines", "branches", "functions", "statements"];
function round2(x) {
  return Math.round(x * 100) / 100;
}
function coverageDelta(before, after) {
  return {
    lines: round2(after.lines - before.lines),
    branches: round2(after.branches - before.branches),
    functions: round2(after.functions - before.functions),
    statements: round2(after.statements - before.statements)
  };
}
function regressions(delta, tolerance) {
  const threshold = -1 * tolerance;
  return METRICS.filter((m) => delta[m] < threshold);
}
var COVERAGE_FLAGS = [
  "--coverage.enabled=true",
  "--coverage.reporter=json-summary",
  "--coverage.reportsDirectory=coverage"
];
function resolveCoverageCommand(contract) {
  const override = contractCommand(contract, "coverage");
  if (override !== void 0) {
    return { ok: true, cmd: { kind: "argv", argv: override } };
  }
  const test = contractCommand(contract, "test");
  if (test === void 0) {
    return { ok: true, cmd: { kind: "vitest", args: ["run", ...COVERAGE_FLAGS] } };
  }
  if (test[0] !== "vitest") {
    return {
      ok: false,
      reason: `cannot derive a coverage command from contracted test command '${test.join(" ")}' \u2014 contract gates.coverage.command (it must write coverage/coverage-summary.json) or waive the coverage gate`
    };
  }
  const tail = test.slice(1);
  const args = tail[0] === "run" ? tail : ["run", ...tail];
  return { ok: true, cmd: { kind: "vitest", args: [...args, ...COVERAGE_FLAGS] } };
}
function measurementFailure(which, m) {
  switch (m.kind) {
    case "command-failed": {
      const out = excerpt(m.proc.stderr || m.proc.stdout);
      return `coverage measurement (${which}): command failed exit=${m.proc.code ?? "null"}` + (out ? `: ${out}` : "");
    }
    case "summary-missing":
      return `coverage measurement (${which}): command exited 0 but wrote no coverage/coverage-summary.json`;
    case "summary-invalid":
      return `coverage measurement (${which}): coverage/coverage-summary.json invalid (corrupt or missing a metric)`;
  }
}
async function summaryFor(ctx, which, treeSha, measure) {
  const cached = await ctx.coverageStore?.get(treeSha);
  if (cached != null) {
    return cached;
  }
  const m = await measure();
  if (m.kind !== "measured") {
    return { failed: measurementFailure(which, m) };
  }
  await ctx.coverageStore?.put(treeSha, m.summary);
  return m.summary;
}
var coverageStrategy = {
  id: "coverage",
  async run(ctx) {
    const opts = { cwd: ctx.worktree };
    if (ctx.contract === void 0) {
      throw new Error("coverage strategy invoked without a gate contract \u2014 the runner must load it first");
    }
    const resolution = resolveCoverageCommand(ctx.contract);
    if (!resolution.ok) {
      return ran("coverage", false, resolution.reason);
    }
    const base = await resolveBase(ctx.tools, ctx.baseRef, opts);
    if (base === null) {
      return ran("coverage", false, `base_ref_not_found: origin/${ctx.baseRef} and ${ctx.baseRef}`);
    }
    const headTree = await ctx.tools.git.treeSha(opts);
    const baseSha = await ctx.tools.git.revParse(base, opts);
    const baseTree = await ctx.tools.git.revParse(`${base}^{tree}`, opts);
    const head = await summaryFor(ctx, "head", headTree, () => ctx.tools.coverage.measure(resolution.cmd, opts));
    if ("failed" in head) {
      return ran("coverage", false, head.failed);
    }
    const before = await summaryFor(
      ctx,
      `base ${baseSha}`,
      baseTree,
      () => ctx.tools.coverage.measureAtBase(baseSha, resolution.cmd, opts)
    );
    if ("failed" in before) {
      return ran(
        "coverage",
        false,
        `${before.failed} \u2014 base is measured under head's node_modules; if this task changed deps, contract gates.coverage.command or waive coverage`
      );
    }
    const tolerance = ctx.config.quality.coverageRegressionTolerancePct;
    const delta = coverageDelta(before, head);
    const failed = regressions(delta, tolerance);
    if (failed.length > 0) {
      const named = failed.map((m) => `${m} (${delta[m]}%)`).join(", ");
      return ran("coverage", false, `coverage decreased beyond ${tolerance}%: ${named}`);
    }
    return ran("coverage", true, `coverage within tolerance ${tolerance}%`);
  }
};

// src/verifier/deterministic/strategies/mutation.ts
function scorePasses(score, target) {
  return score >= target;
}
var STRYKER_CONFIGS = STRYKER_CONFIG_BASENAMES;
var STRYKER_BIN = "node_modules/.bin/stryker";
var mutationStrategy = {
  id: "mutation",
  async run(ctx) {
    const target = ctx.config.quality.mutationScoreTarget;
    const opts = { cwd: ctx.worktree };
    if (!await ctx.tools.fs.exists(STRYKER_BIN, opts)) {
      return skip("mutation", "no-mutation-binary");
    }
    if (!await ctx.tools.fs.existsAny(STRYKER_CONFIGS, opts)) {
      return skip("mutation", "no-mutation-config");
    }
    const base = /^[a-f0-9]{40,64}$/.test(ctx.baseRef) ? ctx.baseRef : `origin/${ctx.baseRef}`;
    if (!await ctx.tools.git.refExists(base, opts)) {
      return ran("mutation", false, `base-missing: ${base} not found`);
    }
    const changed = await ctx.tools.git.changedFiles(base, opts);
    const scope = mutationScope(changed, mutationRoots(ctx.contract));
    if (scope.length === 0) {
      return skip("mutation", "no-mutable-changes");
    }
    const result = await ctx.tools.stryker.run(scope, opts);
    if (result.proc.truncated) {
      throw new Error("mutation gate: stryker report truncated \u2014 refusing to parse a clipped payload");
    }
    const report = result.report;
    if (report.report === "present" && report.mutationScore !== null) {
      const score = report.mutationScore;
      return scorePasses(score, target) ? ran("mutation", true, `mutation score ${score} >= ${target} (scope ${scope.length})`) : ran("mutation", false, `score-below-target: ${score} < ${target}`);
    }
    if (result.proc.code !== 0) {
      return ran("mutation", false, `stryker-failed: exit=${result.proc.code ?? "null"}`);
    }
    if (report.report === "absent") {
      return ran("mutation", false, "no-report: stryker produced no report despite mutable files");
    }
    if (report.report === "unparseable") {
      return ran("mutation", false, "unparseable-report: stryker report JSON did not parse");
    }
    return ran("mutation", false, "no-score: report has no derivable mutation score");
  }
};

// src/verifier/deterministic/strategies/sast.ts
function isAllowedSecurityRunner(argv) {
  const runner = runnerName(argv);
  const a1 = argv[1];
  const a2 = argv[2];
  switch (runner) {
    case "semgrep":
    case "pytest":
    case "vitest":
    case "jest":
    case "mocha":
    case "phpunit":
    case "rspec":
      return true;
    case "go":
    case "cargo":
    case "deno":
      return a1 === "test";
    case "bundle":
      return a1 === "exec" && a2 === "rspec";
    default:
      return false;
  }
}
function validateSecurityCommand(command) {
  return validateCommand(command, isAllowedSecurityRunner);
}
var sastStrategy = {
  id: "sast",
  async run(ctx) {
    const command = ctx.config.quality.securityCommand;
    if (command === void 0 || command.trim().length === 0) {
      return skip("sast", "no-security-command");
    }
    const validation = validateSecurityCommand(command);
    if (!validation.ok) {
      return ran("sast", false, `${validation.reason}: ${validation.detail}`);
    }
    const result = await ctx.tools.semgrep.run(validation.argv, { cwd: ctx.worktree });
    if (result.truncated) {
      throw new Error("sast gate: semgrep output truncated \u2014 refusing to parse a clipped payload");
    }
    const redact = ctx.config.quality.securityRedactFindings;
    const rawOutput = `${result.stdout}
${result.stderr}`.trim();
    const output = redact ? redactSecrets(rawOutput) : rawOutput;
    const exit = `exit=${result.code ?? "null"}`;
    const detail = output.length > 0 ? `${exit} :: ${output}` : exit;
    const clean = result.code === 0;
    if (clean) {
      return ran("sast", true, `security ${detail}`);
    }
    if (ctx.config.quality.securityAllowFailures) {
      return ran("sast", true, `security findings present but non-blocking (allowFailures) ${detail}`);
    }
    return ran("sast", false, `security findings present ${detail}`);
  }
};

// src/verifier/deterministic/strategies/type.ts
var typeStrategy = procStrategy(
  "type",
  "tsc --noEmit",
  (tools, opts) => tools.tsc.typecheck(opts)
);

// src/verifier/deterministic/strategies/build.ts
var buildStrategy = procStrategy(
  "build",
  "build",
  (tools, opts) => tools.build.build(opts)
);

// src/verifier/deterministic/gate-runner.ts
var log20 = createLogger("gate-runner");
function strategyFor(id) {
  switch (id) {
    case "test":
      return testStrategy;
    case "tdd":
      return tddStrategy;
    case "coverage":
      return coverageStrategy;
    case "mutation":
      return mutationStrategy;
    case "sast":
      return sastStrategy;
    case "type":
      return typeStrategy;
    case "lint":
      return lintStrategy;
    case "build":
      return buildStrategy;
    default:
      return assertNever(id);
  }
}
var GateRunner = class {
  /**
   * Run the configured gates against `ctx.worktree`, collect evidence, and return
   * the report + DERIVED verdict. A strategy that throws (a structural/loud error
   * such as truncated tool output) propagates — the runner never swallows it into a
   * silent pass.
   */
  async run(ctx) {
    const gates = ctx.gates ?? GATE_IDS;
    const report = [];
    const evidence = [];
    const skipped = [];
    const load = await (ctx.loadContract ?? loadGateContract)(ctx.worktree);
    if (load.state === "invalid") {
      throw new Error(
        `gate contract: .factory/gates.json is INVALID (${load.error}) \u2014 fix or re-run \`factory scaffold\``
      );
    }
    if (load.state === "absent") {
      throw new Error(
        "gate contract: no .factory/gates.json in this worktree \u2014 the worktree was cut from a commit without the contract (older factory version, or the contract was never committed). Run `factory scaffold`, commit .factory/gates.json, and start a fresh run."
      );
    }
    const contract = load.contract;
    for (const id of gates) {
      const entry = contract.gates[id];
      if (!entry.contracted) {
        const reason = `uncontracted: ${entry.reason}`;
        report.push({ gate: id, outcome: { kind: "skip", gate: id, reason } });
        skipped.push({ gate: id, reason });
        log20.debug(`gate ${id} skipped: ${reason}`);
        continue;
      }
      const strategy = strategyFor(id);
      const sctx = {
        runId: ctx.runId,
        taskId: ctx.taskId,
        worktree: ctx.worktree,
        baseRef: ctx.baseRef,
        config: ctx.config,
        tools: ctx.tools,
        exemptReader: ctx.exemptReader,
        contract,
        coverageStore: ctx.coverageStore
      };
      let outcome = await strategy.run(sctx);
      if (outcome.kind === "skip" && classifySkip(outcome.reason) === "tooling") {
        outcome = ran(id, false, `contracted-but-unrunnable: ${outcome.reason}`);
        log20.warn(`gate ${id} contracted but unrunnable \u2014 failing loud`);
      }
      report.push({ gate: id, outcome });
      if (outcome.kind === "ran") {
        evidence.push(outcome.evidence);
      } else {
        skipped.push({ gate: outcome.gate, reason: outcome.reason });
        log20.debug(`gate ${id} skipped: ${outcome.reason}`);
      }
    }
    const verdict = deriveAllGatesVerdict(evidence);
    return { report, evidence, skipped, verdict };
  }
};

// src/verifier/deterministic/tools.ts
import { access as access3, mkdtemp, readFile as readFile12, rm as rm4, symlink as symlink2, unlink as unlink4 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import path2 from "node:path";
function toProc(r) {
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated };
}
function assertNotTruncated(r, what) {
  if (r.truncated) {
    throw new Error(
      `WS6 tool output for ${what} was TRUNCATED (hit maxBuffer) \u2014 refusing to parse a clipped payload`
    );
  }
}
async function resolveLocalBin(cwd, tool, exists = pathExists) {
  let dir = path2.resolve(cwd);
  for (; ; ) {
    const candidate = path2.join(dir, "node_modules", ".bin", tool);
    if (await exists(candidate)) {
      return candidate;
    }
    const parent = path2.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
var defaultLocalBinResolver = (tool, opts) => resolveLocalBin(opts.cwd, tool);
function missingBinResult(tool, cwd) {
  return {
    stdout: "",
    stderr: `${tool}: no local binary found under node_modules/.bin (walked up from ${cwd}); refusing the npx fallback \u2014 a bare \`npx ${tool}\` resolves a remote registry decoy under corepack/pnpm. Install dev dependencies so ${tool} resolves locally.`,
    code: 127,
    signal: null,
    truncated: false
  };
}
async function runTool(resolve2, tool, toolArgs, opts, env = {}) {
  const localBin = await resolve2(tool, opts);
  if (localBin === null) {
    return missingBinResult(tool, opts.cwd);
  }
  return exec(localBin, [...toolArgs], { cwd: opts.cwd, env });
}
var DefaultVitestTool = class {
  constructor(resolve2 = defaultLocalBinResolver, env = {}) {
    this.resolve = resolve2;
    this.env = env;
  }
  async run(files, opts) {
    const args = ["run", "--coverage.enabled=false", ...files];
    return toProc(await runTool(this.resolve, "vitest", args, opts, this.env));
  }
};
var DefaultTscTool = class {
  constructor(resolve2 = defaultLocalBinResolver, env = {}) {
    this.resolve = resolve2;
    this.env = env;
  }
  async typecheck(opts) {
    return toProc(await runTool(this.resolve, "tsc", ["--noEmit"], opts, this.env));
  }
};
var DefaultEslintTool = class {
  constructor(resolve2 = defaultLocalBinResolver, env = {}) {
    this.resolve = resolve2;
    this.env = env;
  }
  async lint(opts) {
    return toProc(await runTool(this.resolve, "eslint", ["."], opts, this.env));
  }
};
var DefaultBuildTool = class {
  constructor(env = {}) {
    this.env = env;
  }
  async build(opts) {
    return toProc(await exec("npm", ["run", "build"], { cwd: opts.cwd, env: this.env }));
  }
};
var DefaultArgvRunner = class {
  constructor(env = {}) {
    this.env = env;
  }
  async run(command, opts) {
    const [bin, ...rest] = command;
    if (bin === void 0) {
      throw new Error("DefaultArgvRunner: empty command");
    }
    return toProc(await exec(bin, rest, { cwd: opts.cwd, env: this.env }));
  }
};
var DefaultStrykerTool = class _DefaultStrykerTool {
  constructor(resolve2 = defaultLocalBinResolver, env = {}) {
    this.resolve = resolve2;
    this.env = env;
  }
  /** Report path relative to the worktree (stryker html/json reporter default). */
  static REPORT_PATH = "reports/mutation/mutation.json";
  async run(mutate, opts) {
    const reportPath = path2.join(opts.cwd, _DefaultStrykerTool.REPORT_PATH);
    try {
      await unlink4(reportPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    const csv = mutate.map(escapeStrykerGlob).join(",");
    const proc = toProc(await runTool(this.resolve, "stryker", ["run", "--mutate", csv], opts, this.env));
    let raw;
    try {
      raw = await readFile12(reportPath, "utf8");
    } catch {
      return { proc, report: { report: "absent" } };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { proc, report: { report: "unparseable" } };
    }
    const score = extractMutationScore(parsed);
    return { proc, report: { report: "present", mutationScore: score } };
  }
};
function extractMutationScore(report) {
  if (typeof report !== "object" || report === null) {
    return null;
  }
  const metrics = report.metrics;
  if (typeof metrics === "object" && metrics !== null) {
    const score = metrics.mutationScore;
    if (typeof score === "number" && Number.isFinite(score)) {
      return score;
    }
  }
  return computeMutationScore(report);
}
var DETECTED_STATUSES = /* @__PURE__ */ new Set(["killed", "timeout"]);
var UNDETECTED_STATUSES = /* @__PURE__ */ new Set(["survived", "nocoverage"]);
function computeMutationScore(report) {
  const files = report.files;
  if (typeof files !== "object" || files === null) {
    return null;
  }
  let detected = 0;
  let valid = 0;
  for (const file of Object.values(files)) {
    const mutants = file.mutants;
    if (!Array.isArray(mutants)) {
      continue;
    }
    for (const mutant of mutants) {
      const rawStatus = mutant.status;
      if (typeof rawStatus !== "string") {
        continue;
      }
      const status = rawStatus.toLowerCase();
      if (DETECTED_STATUSES.has(status)) {
        detected += 1;
        valid += 1;
      } else if (UNDETECTED_STATUSES.has(status)) {
        valid += 1;
      }
    }
  }
  return valid > 0 ? detected / valid * 100 : null;
}
var DefaultCoverageTool = class _DefaultCoverageTool {
  constructor(resolve2 = defaultLocalBinResolver, env = {}) {
    this.resolve = resolve2;
    this.env = env;
  }
  /** Where every measurement must land, relative to the measured tree's root. */
  static SUMMARY_PATH = path2.join("coverage", "coverage-summary.json");
  async measure(cmd, opts) {
    const summaryPath = path2.join(opts.cwd, _DefaultCoverageTool.SUMMARY_PATH);
    await rm4(summaryPath, { force: true });
    let result;
    if (cmd.kind === "vitest") {
      result = await runTool(this.resolve, "vitest", cmd.args, opts, this.env);
    } else {
      const [bin, ...rest] = cmd.argv;
      if (bin === void 0) {
        throw new Error("DefaultCoverageTool: empty command");
      }
      result = await exec(bin, rest, { cwd: opts.cwd, env: this.env });
    }
    if (result.code !== 0) {
      return { kind: "command-failed", proc: toProc(result) };
    }
    let raw;
    try {
      raw = await readFile12(summaryPath, "utf8");
    } catch {
      return { kind: "summary-missing" };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "summary-invalid" };
    }
    const summary = parseCoverageSummary(parsed);
    return summary === null ? { kind: "summary-invalid" } : { kind: "measured", summary };
  }
  async measureAtBase(baseSha, cmd, opts) {
    const scratch = await mkdtemp(path2.join(tmpdir2(), "factory-cov-base-"));
    const wt = path2.join(scratch, "wt");
    try {
      const add = await exec("git", ["-C", opts.cwd, "worktree", "add", "--detach", wt, baseSha], {
        cwd: opts.cwd
      });
      if (add.code !== 0) {
        throw new Error(
          `coverage base measurement: git worktree add --detach ${baseSha} failed (code=${add.code ?? "null"}): ${add.stderr.trim()}`
        );
      }
      if (await pathExists(path2.join(opts.cwd, "node_modules"))) {
        await symlink2(path2.join(opts.cwd, "node_modules"), path2.join(wt, "node_modules"), "dir");
      }
      return await this.measure(cmd, { cwd: wt });
    } finally {
      await exec("git", ["-C", opts.cwd, "worktree", "remove", "--force", wt], {
        cwd: opts.cwd
      }).catch(() => {
      });
      await rm4(scratch, { recursive: true, force: true }).catch(() => {
      });
      await exec("git", ["-C", opts.cwd, "worktree", "prune"], { cwd: opts.cwd }).catch(() => {
      });
    }
  }
};
var DefaultFsProbe = class {
  async exists(relPath, opts) {
    try {
      await access3(path2.join(opts.cwd, relPath));
      return true;
    } catch {
      return false;
    }
  }
  async existsAny(relPaths, opts) {
    for (const rel of relPaths) {
      if (await this.exists(rel, opts)) {
        return true;
      }
    }
    return false;
  }
};
function isPct(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
}
function readMetric(total, key) {
  const v = total[key];
  if (isPct(v)) {
    return v;
  }
  if (typeof v === "object" && v !== null && isPct(v.pct)) {
    return v.pct;
  }
  return null;
}
function parseCoverageSummary(report) {
  if (typeof report !== "object" || report === null) {
    return null;
  }
  const total = report.total;
  if (typeof total !== "object" || total === null) {
    return null;
  }
  const t = total;
  const lines = readMetric(t, "lines");
  const branches = readMetric(t, "branches");
  const functions = readMetric(t, "functions");
  const statements = readMetric(t, "statements");
  if (lines === null || branches === null || functions === null || statements === null) {
    return null;
  }
  return { lines, branches, functions, statements };
}
var DefaultGitProbe = class {
  async git(args, cwd) {
    return exec("git", args, { cwd });
  }
  async refExists(ref, opts) {
    const r = await this.git(["rev-parse", "--verify", "--quiet", ref], opts.cwd);
    return r.code === 0;
  }
  async revParse(ref, opts) {
    const r = await this.git(["rev-parse", ref], opts.cwd);
    if (r.code !== 0) {
      throw new Error(`git rev-parse ${ref} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
    }
    return r.stdout.trim();
  }
  async treeSha(opts) {
    return this.revParse("HEAD^{tree}", opts);
  }
  async changedFiles(base, opts) {
    const r = await this.git(["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`], opts.cwd);
    if (r.code !== 0) {
      throw new Error(`git diff vs ${base} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
    }
    assertNotTruncated(r, "git diff --name-only");
    return splitLines(r.stdout);
  }
  async commits(base, taskId, opts) {
    const log24 = await this.git(["log", "--format=%H", `${base}..HEAD`], opts.cwd);
    if (log24.code !== 0) {
      throw new Error(`git log ${base}..HEAD failed (code=${log24.code ?? "null"}): ${log24.stderr.trim()}`);
    }
    assertNotTruncated(log24, "git log (tdd classification)");
    const shas = splitLines(log24.stdout).reverse();
    const out = [];
    for (const sha of shas) {
      const parents = await this.git(["show", "-s", "--format=%P", sha], opts.cwd);
      if (parents.code !== 0) {
        throw new Error(`git show parents of ${sha} failed: ${parents.stderr.trim()}`);
      }
      assertNotTruncated(parents, `git show parents of ${sha}`);
      const parentShas = parents.stdout.trim().split(/\s+/).filter((s) => s.length > 0);
      const parentCount = parentShas.length;
      let files;
      if (parentCount > 1) {
        const firstParent = at(parentShas, 0);
        const dt = await this.git(
          ["diff-tree", "--no-commit-id", "--name-only", "-r", firstParent, sha],
          opts.cwd
        );
        if (dt.code !== 0) {
          throw new Error(`git diff-tree failed for ${sha}: ${dt.stderr.trim()}`);
        }
        assertNotTruncated(dt, `git diff-tree (merge) for ${sha}`);
        files = splitLines(dt.stdout);
      } else {
        const dt = await this.git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], opts.cwd);
        if (dt.code !== 0) {
          throw new Error(`git diff-tree failed for ${sha}: ${dt.stderr.trim()}`);
        }
        assertNotTruncated(dt, `git diff-tree for ${sha}`);
        files = splitLines(dt.stdout);
      }
      const subjBody = await this.git(["log", "-1", "--format=%s%n%b", sha], opts.cwd);
      if (subjBody.code !== 0) {
        throw new Error(`git log subject/body of ${sha} failed: ${subjBody.stderr.trim()}`);
      }
      assertNotTruncated(subjBody, `git log subject/body of ${sha}`);
      const tagged = subjBody.stdout.includes(`[${taskId}]`);
      out.push({ sha, files, parentCount, tagged });
    }
    return out;
  }
};
function splitLines(s) {
  return s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}
function defaultGateTools(gateEnv = {}) {
  return {
    git: new DefaultGitProbe(),
    vitest: new DefaultVitestTool(defaultLocalBinResolver, gateEnv),
    tsc: new DefaultTscTool(defaultLocalBinResolver, gateEnv),
    eslint: new DefaultEslintTool(defaultLocalBinResolver, gateEnv),
    build: new DefaultBuildTool(gateEnv),
    semgrep: new DefaultArgvRunner(gateEnv),
    stryker: new DefaultStrykerTool(defaultLocalBinResolver, gateEnv),
    coverage: new DefaultCoverageTool(defaultLocalBinResolver, gateEnv),
    fs: new DefaultFsProbe(),
    command: new DefaultArgvRunner(gateEnv)
  };
}

// src/feature/test-evidence.ts
import { stripVTControlCharacters } from "node:util";
function testEvidence(proc) {
  if (proc.truncated) {
    throw new Error("test evidence was truncated");
  }
  const output = stripVTControlCharacters(`${proc.stdout}
${proc.stderr}`);
  let executed = 0;
  try {
    const value = JSON.parse(proc.stdout);
    if (typeof value === "object" && value !== null && "numPassedTests" in value && "numFailedTests" in value && typeof value.numPassedTests === "number" && typeof value.numFailedTests === "number") {
      executed = value.numPassedTests + value.numFailedTests;
    }
  } catch {
  }
  const passed = /^(?:#|ℹ) pass (\d+)\s*$/m.exec(output);
  const failed = /^(?:#|ℹ) fail (\d+)\s*$/m.exec(output);
  if (passed && failed) {
    executed = Number(passed[1]) + Number(failed[1]);
  }
  const summary = /^\s*Tests\s+(.+)$/m.exec(output)?.[1];
  if (summary !== void 0) {
    executed = [...summary.matchAll(/(\d+)\s+(?:passed|failed)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  }
  if (!Number.isInteger(executed) || executed <= 0) {
    throw new Error(
      "test command provided no recognized executed-test evidence; configure a TAP, Node, Jest JSON or Vitest reporter"
    );
  }
  return {
    executed,
    assertionFailure: proc.code !== 0 && /AssertionError|ERR_ASSERTION|expected .+ to |toEqual|toBe\(/i.test(output)
  };
}

// src/verifier/deterministic/tdd-exempt.ts
var log21 = createLogger("verifier:tdd-exempt");
function isTddExempt(taskId, tasksJson, packageJson) {
  const list = extractTaskList(tasksJson);
  for (const entry of list) {
    if (typeof entry === "object" && entry !== null && entry.task_id === taskId && entry.tdd_exempt === true) {
      return true;
    }
  }
  if (typeof packageJson === "object" && packageJson !== null && typeof packageJson.factory === "object" && packageJson.factory?.tddExempt === true) {
    return true;
  }
  return false;
}
function extractTaskList(tasksJson) {
  if (Array.isArray(tasksJson)) {
    return tasksJson;
  }
  if (typeof tasksJson === "object" && tasksJson !== null && Array.isArray(tasksJson.tasks)) {
    return tasksJson.tasks;
  }
  return [];
}

// src/verifier/judgment/db-detect.ts
var DB_PATH_PATTERNS = [
  /(^|\/)migrations\//,
  // generic + supabase/migrations, django, alembic-as-migrations
  /(^|\/)db\/migrate\//,
  // rails
  /(^|\/)alembic\/versions\//,
  // alembic default layout
  /(^|\/)drizzle\//,
  // drizzle-kit output
  /(^|\/)schema\.prisma$/,
  // prisma
  /\.sql$/i
  // bare SQL anywhere
];
function isDbPath(path3) {
  return DB_PATH_PATTERNS.some((p) => p.test(path3));
}

// src/feature/runtime.ts
var PrSchema = external_exports.object({
  number: external_exports.number().int().positive(),
  url: external_exports.string(),
  state: external_exports.enum(["OPEN", "CLOSED", "MERGED"]),
  headRefOid: external_exports.string(),
  baseRefName: external_exports.string()
});
var LocalFeatureRuntime = class {
  constructor(config, usage, command = (name, args, cwd) => exec(name, args, { cwd, timeoutMs: 6e5 })) {
    this.config = config;
    this.usage = usage;
    this.command = command;
  }
  now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  get ciWaitMinutes() {
    return this.config.git.rollupCiWaitMinutes;
  }
  async checked(name, args, cwd) {
    const result = await this.command(name, args, cwd);
    if (result.code !== 0 || result.truncated) {
      throw new Error(`${name} ${args[0]} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  }
  async prepare(root, worktree, branch, base) {
    try {
      await access4(join17(worktree, ".git"));
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
      const exists = await this.command("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
      if (exists.code !== 0 && exists.code !== 1) {
        throw new Error("cannot inspect feature branch");
      }
      await this.checked(
        "git",
        exists.code === 0 ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, base],
        root
      );
    }
    const actual = await this.checked("git", ["symbolic-ref", "--short", "HEAD"], worktree);
    if (actual !== branch || !await this.ancestor(worktree, base, await this.head(worktree))) {
      throw new Error("existing feature worktree has a different branch/base; preserved for inspection");
    }
    await provisionWorktree({ path: worktree, setupCommand: this.config.quality.setupCommand });
  }
  head(worktree) {
    return this.checked("git", ["rev-parse", "HEAD"], worktree);
  }
  async clean(worktree) {
    return await this.checked("git", ["status", "--porcelain"], worktree) === "";
  }
  async ancestor(worktree, ancestor, head) {
    const result = await this.command("git", ["merge-base", "--is-ancestor", ancestor, head], worktree);
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`cannot check Git ancestry: ${result.stderr}`);
    }
    return result.code === 0;
  }
  async exempt(run5) {
    let pkg = null;
    const tracked = await this.checked(
      "git",
      ["ls-tree", "--name-only", run5.spec.base_sha, "--", "package.json"],
      run5.worktree
    );
    if (tracked) {
      pkg = JSON.parse(await this.checked("git", ["show", `${run5.spec.base_sha}:package.json`], run5.worktree));
    }
    const task = at(run5.spec.tasks, Math.min(run5.task_index, run5.spec.tasks.length - 1));
    return isTddExempt(task.task_id, run5.spec.tasks, pkg);
  }
  async checks(run5, stage) {
    const task = at(run5.spec.tasks, Math.min(run5.task_index, run5.spec.tasks.length - 1));
    const full = stage === "slice-check" || stage === "feature-check";
    const gates = stage === "tests" ? ["test"] : full ? ["test", "type", "lint", "build", "coverage", "mutation", "sast"] : ["test", "type", "lint"];
    const tools = defaultGateTools();
    const baseRef = full ? stage === "slice-check" ? run5.slice_base_sha : run5.spec.base_sha : run5.task_base_sha;
    const context = {
      runId: run5.run_id,
      taskId: task.task_id,
      worktree: run5.worktree,
      baseRef,
      config: this.config
    };
    const outputs = [];
    const testResult = await new GateRunner().run({
      ...context,
      gates: ["test"],
      tools: {
        ...tools,
        vitest: {
          run: async (files, options) => {
            const output = await tools.vitest.run(full ? [] : files, options);
            outputs.push(output);
            return output;
          }
        },
        command: {
          run: async (command, options) => {
            const output = await tools.command.run(command, options);
            outputs.push(output);
            return output;
          }
        }
      }
    });
    if (outputs.length !== 1) {
      throw new Error("test gate did not execute exactly one test command");
    }
    const tests = testEvidence(at(outputs, 0));
    const result = await new GateRunner().run({
      ...context,
      tools,
      gates: gates.filter((gate) => gate !== "test")
    });
    const report = {
      passed: deriveAllGatesVerdict([...testResult.evidence, ...result.evidence]).passed,
      observed: tests.executed + result.evidence.length,
      assertionFailure: tests.assertionFailure,
      details: [...testResult.report, ...result.report, { executed_tests: tests.executed }].map(
        (item) => JSON.stringify(item)
      )
    };
    if ((stage === "tests" || stage === "task-check") && !run5.candidate_satisfied && !await this.exempt(run5)) {
      const commits = await tools.git.commits(run5.task_base_sha, task.task_id, { cwd: run5.worktree });
      if (stage === "tests") {
        report.assertionFailure &&= commits.length > 0 && commits.every((commit) => commit.tagged && classifyCommit(commit.files) === "test-only");
      } else {
        const verdict = deriveTddVerdict(commits, false);
        report.passed &&= verdict.ok;
        report.details.push(`Unsquashed task TDD: ${JSON.stringify(verdict)}`);
      }
    }
    if (stage === "feature-check" && run5.e2e) {
      const output = await this.command("pnpm", ["exec", "playwright", "test", "--reporter=json"], run5.worktree);
      if (output.truncated) {
        throw new Error("E2E evidence was truncated");
      }
      const parsed = external_exports.object({
        stats: external_exports.object({
          expected: external_exports.number(),
          unexpected: external_exports.number(),
          skipped: external_exports.number(),
          flaky: external_exports.number()
        })
      }).parse(JSON.parse(output.stdout));
      report.observed++;
      report.passed &&= output.code === 0 && parsed.stats.expected > 0 && parsed.stats.unexpected === 0 && parsed.stats.skipped === 0;
      report.details.push(`E2E: ${JSON.stringify(parsed.stats)}`);
    }
    return report;
  }
  async snapshot(run5, id, head) {
    const target = join17(run5.root, ".claude", "worktrees", `review-${run5.run_id}-${id}`);
    await this.checked("git", ["worktree", "add", "--detach", target, head], run5.root);
    await provisionWorktree({ path: target, setupCommand: this.config.quality.setupCommand });
    return target;
  }
  async citation(worktree, claim) {
    if (!safeRepoPath(claim.file)) {
      return false;
    }
    const source = await this.checked("git", ["show", `HEAD:${claim.file}`], worktree);
    return source.split("\n").slice(Math.max(0, claim.line - 3), claim.line + 2).join("\n").includes(claim.quote);
  }
  async databaseChanged(run5, base) {
    return (await this.checked("git", ["diff", "--name-only", `${base}...HEAD`], run5.worktree)).split("\n").some(isDbPath);
  }
  async quota(run5) {
    if (run5.ignore_quota) {
      return void 0;
    }
    const decision = evaluate(await this.usage.read(), this.config, Date.now() / 1e3);
    return decision.kind === "proceed" ? void 0 : decision.reason;
  }
  async reconcileBase(run5) {
    await this.checked("git", ["fetch", run5.remote, run5.base_branch], run5.worktree);
    const base = await this.checked("git", ["rev-parse", `${run5.remote}/${run5.base_branch}`], run5.worktree);
    if (await this.ancestor(run5.worktree, base, await this.head(run5.worktree))) {
      return "unchanged";
    }
    const result = await this.command("git", ["merge", "--no-edit", base], run5.worktree);
    if (result.code === 0) {
      return "merged";
    }
    const conflicts = await this.checked("git", ["diff", "--name-only", "--diff-filter=U"], run5.worktree);
    if (conflicts) {
      return "conflict";
    }
    throw new Error(`base integration failed: ${result.stderr || result.stdout}`);
  }
  async noChanges(run5) {
    const result = await this.command(
      "git",
      ["diff", "--quiet", `${run5.remote}/${run5.base_branch}`, "HEAD"],
      run5.worktree
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error("cannot compare feature tree with base");
    }
    return result.code === 0;
  }
  async deliver(run5) {
    const head = await this.head(run5.worktree);
    const list = async () => external_exports.array(PrSchema).parse(
      JSON.parse(
        await this.checked(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            run5.repo,
            "--head",
            run5.branch,
            "--base",
            run5.base_branch,
            "--state",
            "all",
            "--json",
            "number,url,state,headRefOid,baseRefName"
          ],
          run5.worktree
        )
      )
    );
    let prs = await list();
    if (prs.length > 1) {
      throw new Error("multiple feature PRs exist; refusing ambiguous delivery");
    }
    let pr = prs[0];
    if (pr?.state === "MERGED") {
      if (pr.headRefOid !== head) {
        throw new Error("merged PR did not contain the reviewed HEAD");
      }
      return { kind: "merged", number: pr.number, url: pr.url, head };
    }
    if (pr?.state === "CLOSED") {
      throw new Error("feature PR was closed without merge; work preserved");
    }
    await this.checked("git", ["push", "-u", run5.remote, `HEAD:refs/heads/${run5.branch}`], run5.worktree);
    if (!pr) {
      await this.checked(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          run5.repo,
          "--head",
          run5.branch,
          "--base",
          run5.base_branch,
          "--title",
          run5.spec.prd.title,
          "--body",
          `Implements #${run5.spec.prd.issue_number}.

Factory run ${run5.run_id}; reviewed HEAD ${head}.
Spec ${run5.spec_digest}.`
        ],
        run5.worktree
      );
    }
    prs = await list();
    pr = prs[0];
    if (!pr || prs.length !== 1) {
      throw new Error("feature PR identity is missing or ambiguous after push");
    }
    if (pr.headRefOid !== head) {
      return {
        kind: "pending",
        number: pr.number,
        url: pr.url,
        head,
        reason: "waiting for GitHub to observe the reviewed HEAD"
      };
    }
    if (pr.state === "CLOSED") {
      throw new Error("feature PR was closed without merge; work preserved");
    }
    if (pr.state === "MERGED") {
      return { kind: "merged", number: pr.number, url: pr.url, head };
    }
    if (run5.ship_mode === "no-ship" || run5.debug) {
      return { kind: "review", number: pr.number, url: pr.url, head };
    }
    const checkResult = await this.command(
      "gh",
      ["pr", "checks", String(pr.number), "--repo", run5.repo, "--required", "--json", "bucket,name"],
      run5.worktree
    );
    if (checkResult.truncated || ![0, 1, 8].includes(checkResult.code ?? -1)) {
      throw new Error(`cannot read required checks: ${checkResult.stderr}`);
    }
    const checks = external_exports.array(external_exports.object({ bucket: external_exports.string(), name: external_exports.string() })).parse(JSON.parse(checkResult.stdout));
    if (checks.some((check) => ["fail", "cancel"].includes(check.bucket))) {
      return { kind: "failed", number: pr.number, url: pr.url, head, reason: JSON.stringify(checks) };
    }
    if (checks.length === 0 || checks.some((check) => check.bucket !== "pass")) {
      return {
        kind: "pending",
        number: pr.number,
        url: pr.url,
        head,
        reason: "required checks are missing or pending"
      };
    }
    await this.checked(
      "gh",
      ["pr", "merge", String(pr.number), "--repo", run5.repo, "--squash", "--auto", "--match-head-commit", head],
      run5.worktree
    );
    const updated = (await list())[0];
    if (updated?.headRefOid !== head) {
      throw new Error("PR changed during merge request");
    }
    return { kind: updated.state === "MERGED" ? "merged" : "pending", number: updated.number, url: updated.url, head };
  }
  async mergedDelivery(run5) {
    const prs = external_exports.array(PrSchema).parse(
      JSON.parse(
        await this.checked(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            run5.repo,
            "--head",
            run5.branch,
            "--base",
            run5.base_branch,
            "--state",
            "merged",
            "--json",
            "number,url,state,headRefOid,baseRefName"
          ],
          run5.worktree
        )
      )
    );
    if (prs.length === 0) {
      return void 0;
    }
    if (prs.length !== 1 || at(prs, 0).headRefOid !== await this.head(run5.worktree)) {
      throw new Error("merged PR differs from the reviewed feature HEAD");
    }
    const pr = at(prs, 0);
    return { kind: "merged", number: pr.number, url: pr.url, head: pr.headRefOid };
  }
  validateRepair(run5, spec) {
    const gates = runSpecGates(run5.spec.prd, spec.tasks);
    if (!gates.passed) {
      return Promise.reject(new Error(gates.blockers.join("; ")));
    }
    return Promise.resolve();
  }
};

// src/feature/preflight.ts
async function assertFeatureEnvironment(spec, repo, config, gh = new DefaultGhClient()) {
  const raw = spec.contracts[GATE_CONTRACT_REL];
  if (raw === void 0) {
    throw new Error("base commit has no gate contract; run factory scaffold, commit it, and regenerate the spec");
  }
  const contract = GateContractSchema.parse(JSON.parse(raw));
  const [owner, name] = repo.split("/");
  if (owner === void 0 || owner === "" || name === void 0 || name === "") {
    throw new Error("repository must be owner/name");
  }
  const protection = await gh.repoProtection(owner, name, config.git.baseBranch);
  requireProtectionOrRefuse(
    protection,
    effectiveProfiles(config.git, requiredCheckExtras(contract)).run,
    config.git.baseBranch
  );
}

// src/feature/cli.ts
var HELP3 = `Factory v2 \u2014 sequential feature delivery

factory spec resolve|gate|store --issue <n>
factory run create --issue <n> [--no-ship] [--e2e] [--ignore-quota]
factory next-action --run <id> --driver <session> [--results <json-file>]
factory run stop --run <id>
factory resume --run <id> [--answer <text>] [--recover]
factory run cancel --run <id>
factory state --run <id> [--ledger]
factory state --list
factory debug create --base <ref> [--ignore-quota]

--recover retires an interrupted attempt after its previous agent has been stopped.
Legacy runs are preserved but cannot execute. One active feature run per repository.
`;
function featureCommand(name) {
  return {
    describe: `Feature ${name} (v2)`,
    run: withUsageGuard(`factory ${name}`, async (argv) => {
      if (["rescue", "reconcile", "score", "miss"].includes(name)) {
        throw new UsageError(
          `${name} is retired for v2; inspect state --run <id> --ledger and use resume explicitly`
        );
      }
      const allowed = name === "run" && argv[0] === "create" ? ["issue", "repo", "run-id", "no-ship", "e2e", "ignore-quota"] : name === "debug" ? ["base", "repo", "run-id", "ignore-quota"] : name === "resume" ? ["run", "answer", "recover"] : name === "next-action" || name === "next-task" ? ["run", "driver", "results"] : name === "state" ? ["run", "list", "ledger"] : ["run"];
      const args = parseArgs(argv, {
        booleans: ["no-ship", "e2e", "ignore-quota", "recover", "list", "ledger"],
        allowed
      });
      if (name === "run" && !["create", "stop", "cancel"].includes(args.positionals[0] ?? "") && args.positionals.length > 0) {
        throw new UsageError("run supports create, stop and cancel; resume is a top-level command");
      }
      if (args.has("help") || args.has("h")) {
        emitHelp(HELP3);
        return EXIT.OK;
      }
      const dataDir = resolveDataDir();
      const config = loadConfig({ dataDir });
      const store = new FeatureStore(dataDir);
      const runtime = new LocalFeatureRuntime(config, new StatuslineUsageSignal({ dataDir }));
      const engine = new FeatureEngine(store, runtime);
      const operation = args.positionals[0];
      const ownerSession = process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
      if (name === "state" && args.has("list")) {
        emitJson(await store.list());
        return EXIT.OK;
      }
      if ((name === "run" || name === "debug") && operation === "create") {
        const root = await runtime.checked("git", ["rev-parse", "--show-toplevel"], process.cwd());
        const repo = await resolveRepo({
          gitClient: new DefaultGitClient(),
          cwd: root,
          explicit: optionalString(args.flag("repo"))
        });
        const runId = optionalString(args.flag("run-id")) ?? randomUUID2();
        if (name === "debug") {
          const base = await runtime.checked("git", ["rev-parse", args.requireFlag("base")], root);
          const head = await runtime.head(root);
          if (!await runtime.clean(root)) {
            throw new Error("commit or stash working changes before creating a debug checkpoint");
          }
          const files = (await runtime.checked("git", ["diff", "--name-only", `${base}...${head}`], root)).split("\n").filter(Boolean);
          if (!files.length) {
            throw new Error("debug requires a nonempty committed diff");
          }
          const spec2 = validateFeatureSpec({
            version: 2,
            revision: 1,
            base_sha: base,
            contracts: {},
            prd: {
              issue_number: 1,
              title: "Focused debug review",
              body: "- Resolve independently verified defects while preserving intended behavior.",
              labels: [],
              body_truncated: false
            },
            spec_md: `Review ${base}...${head}; repair only independently confirmed defects.`,
            tasks: [
              {
                task_id: "debug",
                slice_id: "debug",
                requirement_ids: ["R1"],
                title: "Repair verified defects",
                description: "Preserve documented behavior and repair confirmed defects.",
                files,
                acceptance_criteria: ["Confirmed defects are fixed and regression tests pass."],
                tests_to_write: ["Regression tests for confirmed defects"],
                depends_on: [],
                risk_tier: "high",
                risk_rationale: "Existing implementation review",
                tdd_exempt: true
              }
            ]
          });
          const run5 = await engine.create({
            runId,
            repo,
            root,
            spec: spec2,
            baseBranch: config.git.baseBranch,
            remote: "origin",
            shipMode: "no-ship",
            debug: true,
            ignoreQuota: args.has("ignore-quota"),
            startSha: head
          });
          emitJson(run5);
          return EXIT.OK;
        }
        const issue = Number(args.requireFlag("issue"));
        if (!Number.isSafeInteger(issue) || issue <= 0) {
          throw new UsageError("--issue must be a positive integer");
        }
        const specData = join18(dataDir, "v2");
        const manifest = await new SpecStore({ dataDir: specData }).resolveByIssue(repo, issue);
        if (!manifest) {
          throw new Error("generate and review a fresh v2 spec first");
        }
        const spec = validateFeatureSpec(
          JSON.parse(await readFile13(join18(specDir(specData, repo, manifest.spec_id), "feature.json"), "utf8"))
        );
        const currentPrd = await new RealGhClient().fetchPrd(issue, { repo });
        const snapshot = await repositorySnapshot(root, config);
        if (digest(currentPrd) !== digest(spec.prd) || snapshot.base_sha !== spec.base_sha || digest(snapshot.contracts) !== digest(spec.contracts)) {
          throw new Error("PRD or base changed after spec review; regenerate against the current repository");
        }
        await assertFeatureEnvironment(spec, repo, config);
        emitJson(
          await engine.create({
            runId,
            repo,
            root,
            spec,
            baseBranch: config.git.baseBranch,
            remote: "origin",
            shipMode: args.has("no-ship") ? "no-ship" : "live",
            e2e: args.has("e2e"),
            ignoreQuota: args.has("ignore-quota"),
            ...ownerSession !== void 0 && ownerSession !== "" ? { ownerSession } : {}
          })
        );
        return EXIT.OK;
      }
      const id = args.requireFlag("run");
      if (name === "next-action" || name === "next-task") {
        const resultPath = optionalString(args.flag("results"));
        if (args.has("results") && (resultPath === void 0 || resultPath === "")) {
          throw new UsageError("--results requires a JSON file");
        }
        const raw = resultPath !== void 0 ? JSON.parse(await readFile13(resultPath, "utf8")) : void 0;
        emitJson(await engine.advance(id, args.requireFlag("driver"), raw));
        return EXIT.OK;
      }
      if (name === "resume") {
        emitJson(
          await engine.resume(id, {
            ...args.has("answer") ? { answer: args.requireFlag("answer") } : {},
            recover: args.has("recover")
          })
        );
        return EXIT.OK;
      }
      if (name === "run" && operation === "stop") {
        emitJson(await engine.stop(id));
        return EXIT.OK;
      }
      if (name === "run" && operation === "cancel") {
        emitJson(await engine.resume(id, { cancel: true }));
        return EXIT.OK;
      }
      if (["state", "statusline"].includes(name)) {
        const run5 = await store.read(id);
        if (args.has("ledger")) {
          process.stdout.write(renderLedger(run5));
        } else {
          emitJson(run5);
        }
        return EXIT.OK;
      }
      throw new UsageError(`unsupported ${name} operation; see --help`);
    })
  };
}

// src/cli/subcommands/autonomy.ts
import { existsSync as existsSync10 } from "node:fs";
import { readFile as readFile14 } from "node:fs/promises";
import { join as join19 } from "node:path";
import { homedir as homedir3 } from "node:os";

// src/autonomy/mode.ts
function isAutonomous(env = process.env) {
  return env.FACTORY_AUTONOMOUS_MODE === "1";
}

// src/cli/subcommands/autonomy.ts
var log22 = createLogger("autonomy");
var HELP4 = `factory autonomy <ensure|status|preflight> \u2014 manage / inspect autonomous mode

The pipeline runs unattended: \`run create\`/\`run resume\` HALT unless the session
is autonomous (FACTORY_AUTONOMOUS_MODE=1). There is no opt-out.

ensure     Builds the autonomous settings in memory from templates/settings.autonomous.json
           (placeholders substituted, env baked, statusLine wired to \`factory statusline\`
           and your own statusLine chained) and prints the relaunch command, with the
           settings passed inline as one --settings argument. Nothing is written to disk.
           Your existing ~/.claude/settings.json is NOT re-serialized into this payload
           (it would land in argv/transcript) \u2014 it still applies as an underlying layer.

status     Reports whether THIS session is autonomous (FACTORY_AUTONOMOUS_MODE=1).
           Exits 0 when autonomous, 1 when not (never throws).

preflight  The run-entry check (what \`/factory:run\` calls). Two states: the session
           is autonomous \u2192 proceed (exit 0); it is not \u2192 print the inline-settings
           relaunch command and halt (exit 1). A directly-exported
           FACTORY_AUTONOMOUS_MODE=1 (CI / raw env) satisfies the gate with no
           settings involved. Never throws on the decision path.

Usage:
  factory autonomy ensure
  factory autonomy status [--json]
  factory autonomy preflight

Options:
  --user-settings <path>   (ensure / preflight) Override the user-settings source (default: ~/.claude/settings.json)
  --json                   (status) Emit machine-readable JSON`;
function factoryBinPath(pluginRoot) {
  return `${pluginRoot}/bin/factory`;
}
function tildeExpand(value, home) {
  if (value.startsWith("~")) {
    return home + value.slice(1);
  }
  return value;
}
function substitutePlaceholders(value, vars) {
  if (typeof value === "string") {
    return value.split("${CLAUDE_PLUGIN_ROOT}").join(vars.pluginRoot).split("${CLAUDE_PLUGIN_DATA_TILDE}").join(vars.dataDirTilde).split("${CLAUDE_PLUGIN_DATA}").join(vars.dataDir);
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitutePlaceholders(v, vars));
  }
  if (typeof value === "object" && value !== null) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substitutePlaceholders(v, vars);
    }
    return out;
  }
  return value;
}
function isObject2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function statusLineCommandOf(settings) {
  const sl = settings.statusLine;
  if (!isObject2(sl)) {
    return void 0;
  }
  const cmd = sl.command;
  return typeof cmd === "string" && cmd.length > 0 ? cmd : void 0;
}
function materializeMergedSettings(input) {
  const { dataDir, pluginRoot, home } = input;
  const parsedTemplate = JSON.parse(input.template);
  if (!isObject2(parsedTemplate)) {
    throw new Error("autonomy: settings.autonomous.json is not a JSON object");
  }
  const template = substitutePlaceholders(parsedTemplate, {
    pluginRoot,
    dataDir,
    dataDirTilde: tildeShorten(dataDir, home)
  });
  const merged = { ...template };
  const templateEnv = isObject2(template.env) ? template.env : {};
  const env = { ...templateEnv };
  env.CLAUDE_PLUGIN_DATA = dataDir;
  const ourPath = factoryBinPath(pluginRoot);
  const chained = (() => {
    if (input.userStatusLine === void 0) {
      return void 0;
    }
    const expanded = tildeExpand(input.userStatusLine, home);
    const parts = expanded.split(/\s+/);
    const expandedPath = parts[0] ?? expanded;
    const expandedSub = parts[1];
    const isOurs = expandedPath === ourPath && expandedSub === "statusline";
    return isOurs ? void 0 : expanded;
  })();
  if (chained !== void 0) {
    env.FACTORY_ORIGINAL_STATUSLINE = chained;
  }
  merged.env = env;
  return merged;
}
async function readUserSettings(path3) {
  if (!existsSync10(path3)) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile14(path3, "utf8"));
    if (isObject2(parsed)) {
      return parsed;
    }
    log22.warn(`${path3} is not a JSON object; ignoring`);
  } catch (err) {
    log22.warn(`could not parse ${path3} (${err.message}); ignoring`);
  }
  return {};
}
function renderPosixCommand(spec) {
  const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  return [spec.executable, ...spec.argv].map(quote).join(" ");
}
function buildRelaunchSpec(settings) {
  return {
    executable: "claude",
    argv: ["--worktree", "--settings", JSON.stringify(settings)]
  };
}
async function runAutonomyEnsure(opts = {}) {
  const home = opts.home ?? homedir3();
  const dataDir = opts.dataDir ?? resolveDataDir();
  const pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
  const userSettingsPath = opts.userSettingsPath ?? join19(home, ".claude", "settings.json");
  const write = opts.writeStdout ?? ((t) => process.stdout.write(t));
  const userStatusLine = statusLineCommandOf(await readUserSettings(userSettingsPath));
  const templatePath = join19(pluginRoot, "templates", "settings.autonomous.json");
  const template = await readFile14(templatePath, "utf8");
  const merged = materializeMergedSettings({ template, userStatusLine, dataDir, pluginRoot, home });
  const spec = buildRelaunchSpec(merged);
  const relaunchCommand = renderPosixCommand(spec);
  write(
    `Relaunch the session in autonomous mode with (settings passed inline \u2014 nothing written to disk):

  ${relaunchCommand}

(the first agent turn refreshes the usage cache \u2192 session-mode quota pacing.)
`
  );
  return { spec, relaunchCommand };
}
function runAutonomyStatus(opts = {}) {
  const env = opts.env ?? process.env;
  const write = opts.writeStdout ?? ((t) => process.stdout.write(t));
  const status = {
    autonomous: isAutonomous(env),
    envSet: env.FACTORY_AUTONOMOUS_MODE !== void 0
  };
  if (opts.json === true) {
    write(stringifyJson(status) + "\n");
  } else if (status.autonomous) {
    write("autonomous: yes (FACTORY_AUTONOMOUS_MODE=1)\n");
  } else {
    write(
      `autonomous: NO \u2014 the pipeline will refuse to start or resume a run.
Run \`factory autonomy ensure\` and relaunch with the printed command.
`
    );
  }
  return Promise.resolve(status.autonomous ? EXIT.OK : EXIT.ERROR);
}
async function evaluateAutonomyPreflight(opts = {}) {
  const env = opts.env ?? process.env;
  if (isAutonomous(env)) {
    return { state: "ready" };
  }
  const ensured = await runAutonomyEnsure({
    dataDir: opts.dataDir,
    pluginRoot: opts.pluginRoot,
    home: opts.home,
    userSettingsPath: opts.userSettingsPath,
    writeStdout: opts.writeStdout ?? (() => void 0)
  });
  return { state: "relaunch", spec: ensured.spec, relaunchCommand: ensured.relaunchCommand };
}
async function runAutonomyPreflight(opts = {}) {
  const write = opts.writeStdout ?? ((t) => process.stdout.write(t));
  let result;
  try {
    result = await evaluateAutonomyPreflight({ ...opts, writeStdout: write });
  } catch (err) {
    write(
      `HALT: this session is not autonomous, and the relaunch settings could not be built (${err.message}) \u2014 run \`factory autonomy ensure\` once the environment is set, then relaunch with the printed command.
`
    );
    return EXIT.ERROR;
  }
  if (result.state === "ready") {
    write("OK: autonomous mode ready (FACTORY_AUTONOMOUS_MODE=1).\n");
    return EXIT.OK;
  }
  write("\nHALT: this session is not autonomous \u2014 relaunch to continue (command above).\n");
  return EXIT.ERROR;
}
async function run4(argv) {
  const args = parseArgs(argv, { booleans: ["json"] });
  if (args.flag("help") === true) {
    return emitHelp(HELP4);
  }
  const verb = args.positionals[0];
  if (verb === "status") {
    return runAutonomyStatus({ json: args.flag("json") === true });
  }
  const userSettings = args.flag("user-settings");
  if (verb === "preflight") {
    return runAutonomyPreflight({
      userSettingsPath: typeof userSettings === "string" ? userSettings : void 0
    });
  }
  if (verb !== void 0 && verb !== "ensure") {
    emitError(`autonomy: unknown verb '${verb}' (expected: ensure | status | preflight)`);
    return EXIT.USAGE;
  }
  await runAutonomyEnsure({
    userSettingsPath: typeof userSettings === "string" ? userSettings : void 0
  });
  return EXIT.OK;
}
var autonomyCommand = {
  describe: "Print the inline-settings autonomous relaunch command",
  run: withUsageGuard("autonomy", run4)
};

// src/cli/subcommands/statusline.ts
import { readFile as readFile15 } from "node:fs/promises";
import { join as join20 } from "node:path";

// src/shared/stdin.ts
async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// src/cli/subcommands/statusline.ts
var log23 = createLogger("cli:statusline");
var HELP5 = `factory statusline \u2014 capture Claude Code rate limits + chain the statusline

Wire this as the Claude Code statusLine.command. On every statusline update it
reads the piped JSON payload, writes \`rate_limits + {captured_at}\` to
\${CLAUDE_PLUGIN_DATA}/usage-cache.json (the session-mode quota pacer's input),
and \u2014 if FACTORY_ORIGINAL_STATUSLINE is set \u2014 pipes the same payload to that
command and forwards its stdout as the displayed statusline.

Usage:
  factory statusline        (reads the CC payload from stdin)

This is a side-effecting passthrough, not a machine subcommand: stdout is the
displayed statusline text, NOT a JSON envelope.`;
function cwdOf(payload) {
  if (typeof payload !== "object" || payload === null) {
    return void 0;
  }
  const p = payload;
  const fromWorkspace = p.workspace?.current_dir;
  if (typeof fromWorkspace === "string" && fromWorkspace.length > 0) {
    return fromWorkspace;
  }
  return typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : void 0;
}
function progressEnabled(env = process.env) {
  return env.FACTORY_STATUSLINE_PROGRESS !== "0";
}
var TERMINAL_LINGER_SEC = 30 * 60;
async function renderProgress(deps, payload) {
  try {
    if (!progressEnabled(deps.env ?? process.env)) {
      return "";
    }
    const cwd = cwdOf(payload);
    if (cwd === void 0) {
      return "";
    }
    const dataDir = resolveDataDir(deps.dataDirOptions ?? {});
    const gitClient = deps.gitClient ?? new DefaultGitClient();
    const repo = await resolveRepo({ cwd, gitClient });
    if (deps.featureProgress === true) {
      const run6 = (await new FeatureStore(dataDir).list()).find((run7) => run7.repo === repo && !terminal(run7));
      return run6 === void 0 ? "" : ` ${run6.checkpoints.length}/${run6.spec.tasks.length} tasks accepted (${run6.status})`;
    }
    const raw = await readFile15(join20(currentRepoLinkPath(dataDir, repo), STATE_FILE), "utf8");
    const run5 = JSON.parse(raw);
    if (typeof run5.run_id !== "string" || typeof run5.status !== "string") {
      return "";
    }
    if (run5.status === "completed" || run5.status === "failed" || run5.status === "superseded") {
      const endedMs = typeof run5.ended_at === "string" ? Date.parse(run5.ended_at) : NaN;
      const nowSec = (deps.now ?? nowEpoch)();
      if (!Number.isFinite(endedMs) || nowSec - endedMs / 1e3 > TERMINAL_LINGER_SEC) {
        return "";
      }
    }
    const tasks = Object.values(run5.tasks ?? {});
    const done = tasks.filter((t) => t?.status === "done").length;
    return ` ${done}/${tasks.length} tasks completed`;
  } catch {
    return "";
  }
}
function rateLimitsOf(payload) {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const rl = payload.rate_limits;
  if (typeof rl !== "object" || rl === null) {
    return null;
  }
  return rl;
}
async function writeCache(rateLimits, deps) {
  let dataDir;
  try {
    dataDir = resolveDataDir(deps.dataDirOptions ?? {});
  } catch {
    log23.warn("CLAUDE_PLUGIN_DATA unresolvable; skipping usage-cache.json write");
    return "usage-cache skipped: CLAUDE_PLUGIN_DATA unresolvable";
  }
  const now = (deps.now ?? nowEpoch)();
  const cache = { ...rateLimits, captured_at: now };
  try {
    await atomicWriteFile(usageCachePath(dataDir), stringifyJson(cache));
    return null;
  } catch (err) {
    log23.warn(`failed to write usage-cache.json: ${err.message}`);
    return `usage-cache unwritable: ${err.message}`;
  }
}
async function passthrough(payload, deps) {
  const original = deps.originalStatusline ?? process.env.FACTORY_ORIGINAL_STATUSLINE ?? "";
  if (original.trim().length === 0) {
    return "";
  }
  try {
    const run5 = deps.exec ?? exec;
    const result = await run5(original, [], { shell: true, input: payload, timeoutMs: 3e3 });
    if (result.code !== 0) {
      const why = result.code === null ? `was killed by signal ${result.signal ?? "unknown"} (likely the 3s timeout)` : `exited ${result.code}`;
      log23.warn(`FACTORY_ORIGINAL_STATUSLINE ${why}; statusline left empty`);
      return "";
    }
    return result.stdout;
  } catch (err) {
    log23.warn(`FACTORY_ORIGINAL_STATUSLINE failed to run: ${err.message}`);
    return "";
  }
}
async function runStatusline(argv = [], deps = {}) {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    return emitHelp(HELP5);
  }
  const payload = deps.readStdin ? await deps.readStdin() : await readStdin(deps.stdin);
  let parsed;
  try {
    parsed = payload.trim().length > 0 ? JSON.parse(payload) : void 0;
  } catch {
    parsed = void 0;
  }
  const rateLimits = rateLimitsOf(parsed);
  const cacheFailure = rateLimits !== null ? await writeCache(rateLimits, deps) : null;
  const displayed = await passthrough(payload, deps);
  const progress = await renderProgress(deps, parsed);
  const write = deps.writeStdout ?? ((text) => process.stdout.write(text));
  const base = cacheFailure === null ? displayed : `${displayed} [factory: ${cacheFailure}]`;
  write(`${base}${progress}`.trimStart());
  return EXIT.OK;
}

// src/cli/main.ts
var cliRegistry = {
  "config-defaults": {
    describe: "Print the resolved config (defaults + any config.json) as JSON",
    run: () => {
      const cfg = loadConfig();
      process.stdout.write(stringifyJson(cfg));
      return EXIT.OK;
    }
  },
  configure: configureCommand,
  debug: featureCommand("debug"),
  resume: featureCommand("resume"),
  run: featureCommand("run"),
  spec: specCommand,
  rescue: featureCommand("rescue"),
  reconcile: featureCommand("reconcile"),
  score: featureCommand("score"),
  miss: featureCommand("miss"),
  state: featureCommand("state"),
  scaffold: scaffoldCommand,
  "next-action": featureCommand("next-action"),
  "next-task": featureCommand("next-task"),
  statusline: {
    describe: "Capture rate limits and display feature progress",
    run: (argv) => runStatusline(argv, { featureProgress: true })
  },
  autonomy: autonomyCommand
};
function printHelp() {
  const names = Object.keys(cliRegistry).sort();
  const width = names.reduce((m, n) => Math.max(m, n.length), 0);
  const lines = [
    "factory \u2014 autonomous coding pipeline CLI",
    "",
    "Usage: factory <subcommand> [options]",
    "",
    "Subcommands:",
    ...names.map((n) => `  ${n.padEnd(width)}  ${nonNull(cliRegistry[n]).describe}`),
    "",
    "Run `factory <subcommand> --help` for subcommand-specific help."
  ];
  process.stdout.write(lines.join("\n") + "\n");
}
async function dispatch(argv) {
  const [name, ...rest] = argv;
  if (name === void 0 || name === "--help" || name === "-h") {
    printHelp();
    return EXIT.OK;
  }
  const cmd = cliRegistry[name];
  if (!cmd) {
    process.stderr.write(`factory: unknown subcommand '${name}'. Run \`factory --help\` for usage.
`);
    return EXIT.USAGE;
  }
  return cmd.run(rest);
}

// src/bin/factory.ts
dispatch(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(detail + "\n");
  process.exit(EXIT.ERROR);
});
