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

// node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS({
  "node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/polyfills.js"(exports, module) {
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
          fs2.lutimes = function(path3, at, mt, cb) {
            fs2.open(path3, constants.O_SYMLINK, function(er, fd) {
              if (er) {
                if (cb) cb(er);
                return;
              }
              fs2.futimes(fd, at, mt, function(er2) {
                fs2.close(fd, function(er22) {
                  if (cb) cb(er2 || er22);
                });
              });
            });
          };
          fs2.lutimesSync = function(path3, at, mt) {
            var fd = fs2.openSync(path3, constants.O_SYMLINK);
            var ret;
            var threw = true;
            try {
              ret = fs2.futimesSync(fd, at, mt);
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

// node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS({
  "node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/legacy-streams.js"(exports, module) {
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

// node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/clone.js
var require_clone = __commonJS({
  "node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/clone.js"(exports, module) {
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

// node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS({
  "node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/graceful-fs.js"(exports, module) {
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
      fs2.readFile = readFile12;
      function readFile12(path3, options, cb) {
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
      fs2.writeFile = writeFile2;
      function writeFile2(path3, data, options, cb) {
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
        fs2.appendFile = appendFile2;
      function appendFile2(path3, data, options, cb) {
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
        fs2.copyFile = copyFile2;
      function copyFile2(src, dest, flags, cb) {
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
      fs2.readdir = readdir3;
      var noReaddirOptionVersions = /^v[0-5]\./;
      function readdir3(path3, options, cb) {
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

// node_modules/.pnpm/retry@0.12.0/node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS({
  "node_modules/.pnpm/retry@0.12.0/node_modules/retry/lib/retry_operation.js"(exports, module) {
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

// node_modules/.pnpm/retry@0.12.0/node_modules/retry/lib/retry.js
var require_retry = __commonJS({
  "node_modules/.pnpm/retry@0.12.0/node_modules/retry/lib/retry.js"(exports) {
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

// node_modules/.pnpm/retry@0.12.0/node_modules/retry/index.js
var require_retry2 = __commonJS({
  "node_modules/.pnpm/retry@0.12.0/node_modules/retry/index.js"(exports, module) {
    module.exports = require_retry();
  }
});

// node_modules/.pnpm/signal-exit@3.0.7/node_modules/signal-exit/signals.js
var require_signals = __commonJS({
  "node_modules/.pnpm/signal-exit@3.0.7/node_modules/signal-exit/signals.js"(exports, module) {
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

// node_modules/.pnpm/signal-exit@3.0.7/node_modules/signal-exit/index.js
var require_signal_exit = __commonJS({
  "node_modules/.pnpm/signal-exit@3.0.7/node_modules/signal-exit/index.js"(exports, module) {
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

// node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/mtime-precision.js
var require_mtime_precision = __commonJS({
  "node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/mtime-precision.js"(exports, module) {
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

// node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/lockfile.js
var require_lockfile = __commonJS({
  "node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/lockfile.js"(exports, module) {
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

// node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js
var require_adapter = __commonJS({
  "node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js"(exports, module) {
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

// node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/index.js
var require_proper_lockfile = __commonJS({
  "node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/index.js"(exports, module) {
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

// src/cli/exit-codes.ts
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
import { existsSync, readFileSync } from "node:fs";
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
  if (process.env.FACTORY_QUIET === "1") return LEVEL_RANK.error;
  return LEVEL_RANK.info;
}
function emit(level, scope, args) {
  if (LEVEL_RANK[level] < activeThreshold()) return;
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const msg = args.map((a) => typeof a === "string" ? a : safeStringify(a)).join(" ");
  process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${scope}: ${msg}
`);
}
function safeStringify(value) {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function createLogger(scope) {
  return {
    debug: (...args) => emit("debug", scope, args),
    info: (...args) => emit("info", scope, args),
    warn: (...args) => emit("warn", scope, args),
    error: (...args) => emit("error", scope, args),
    child: (subScope) => createLogger(`${scope}:${subScope}`)
  };
}
var log = createLogger("factory");

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
    const where = sourcePath ? ` (from ${sourcePath})` : "";
    throw new JsonParseError(
      `invalid JSON${where}: ${cause.message}`,
      sourcePath,
      cause
    );
  }
}
function stringifyJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/external.js
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

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/util.js
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

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/ZodError.js
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
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
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

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/locales/en.js
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

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/parseUtil.js
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

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.js
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

// src/config/schema.ts
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
   * Custom "red test" verification command for exotic runners (Go, Ruby,
   * Deno, …) so TDD enforcement need not be bypassed. Optional.
   */
  redTestCommand: external_exports.string().optional(),
  /**
   * Per-worktree environment-prep command run once after the task worktree is
   * created, BEFORE the deterministic command-gates (test/type/build). When
   * unset, a lockfile in the worktree is auto-detected (`package-lock.json` →
   * `npm ci`, `pnpm-lock.yaml`/`yarn.lock` → frozen install); a repo with no
   * lockfile is a no-op. Set this for non-JS repos or custom setups. Optional.
   */
  setupCommand: external_exports.string().optional()
}).default({});
var QuotaSchema = external_exports.object({
  /** Max single sleep chunk per gate call, seconds. */
  sleepCapSec: external_exports.number().int().positive().default(540),
  /** Max wait cycles before the gate ends a wait, count. */
  maxWaitCycles: external_exports.number().int().positive().default(60),
  /** Max consecutive stale-cache cycles before graceful end, count. */
  maxStaleCycles: external_exports.number().int().positive().default(6),
  /** Accumulated wall-clock wait budget across cycles, minutes. */
  wallBudgetMin: external_exports.number().int().positive().default(75),
  /** 5h-window utilization checkpoints by hour 1..5 (% caps). */
  hourlyThresholds: external_exports.array(external_exports.number()).length(5).default([20, 40, 60, 80, 90]),
  /** 7d-window utilization checkpoints by day 1..7 (% caps). */
  dailyThresholds: external_exports.array(external_exports.number()).length(7).default([14, 29, 43, 57, 71, 86, 95]),
  /**
   * Producer-model dial keyed by risk tier (Decision 25). The quota-router (the
   * renamed model-router, narrowed) selects the producer model for a task from
   * its risk tier; this is the ONLY dial it carries — the review panel is
   * risk-INVARIANT (Decision 25/26), so there is NO review-depth/round cap here
   * (the old `--tier` routine/feature/security review caps are DELETED).
   * Defaults: low→fast model, medium→balanced, high→strong.
   */
  producerModels: external_exports.object({
    low: external_exports.string().default("claude-haiku-4-5"),
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
  /** Apex model the spec generator AND reviewer are pinned to (Decision 21). */
  specModel: external_exports.string().min(1).default("opus"),
  /** Apex effort the spec generator AND reviewer are pinned to (Decision 21). */
  specEffort: external_exports.string().min(1).default("max"),
  /** Max bytes of PRD body retained from `gh issue view` before truncation. */
  prdBodyMaxBytes: external_exports.number().int().positive().default(64 * 1024)
}).default({});
var SPEC_DEFAULTS = Object.freeze(SpecSchema.parse({}));
var ReviewSchema = external_exports.object({
  /** Reviewer model id (panel runs on a fixed model per Decision 26). */
  model: external_exports.string().optional(),
  /** Max turns for a deep review pass. */
  maxTurnsDeep: external_exports.number().int().positive().default(40),
  /** Max turns for a quick review pass. */
  maxTurnsQuick: external_exports.number().int().positive().default(20)
}).default({});
var TestWriterSchema = external_exports.object({
  maxTurns: external_exports.number().int().positive().default(30)
}).default({});
var ScribeSchema = external_exports.object({
  maxTurns: external_exports.number().int().positive().default(20)
}).default({});
var CodexSchema = external_exports.object({
  model: external_exports.string().optional()
}).default({});
var ObservabilitySchema = external_exports.object({
  /** Emit the jsonl audit log. */
  auditLog: external_exports.boolean().default(true),
  /** Days to retain metrics before pruning. */
  metricsRetentionDays: external_exports.number().int().positive().default(30)
}).default({});
var DependenciesSchema = external_exports.object({
  /** Poll interval while waiting on a dependency PR, seconds. */
  pollInterval: external_exports.number().int().positive().default(30),
  /** Timeout waiting for a PR to merge, seconds. */
  prMergeTimeout: external_exports.number().int().positive().default(1800)
}).default({});
var GitSchema = external_exports.object({
  /**
   * The durable base branch staging forks from and rolls up into. NEVER
   * `main` (Decision 12/16 — the factory never touches main; promotion to main
   * is human-owned and out of scope).
   */
  baseBranch: external_exports.string().min(1).default("develop"),
  /** The integration branch task PRs serial-merge into (Δ L, §9.2). */
  stagingBranch: external_exports.string().min(1).default("staging"),
  /**
   * Required status-check contexts that branch protection MUST enforce on the
   * staging branch before a run may start. Empty means "no specific checks
   * required" — but protection itself (incl. strict-up-to-date) is still
   * mandatory; see `requireProtectionOrRefuse`.
   */
  requiredStatusChecks: external_exports.array(external_exports.string()).default([]),
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
  branchPrefix: external_exports.string().min(1).default("factory")
}).default({});
var ConfigSchema = external_exports.object({
  quality: QualitySchema,
  quota: QuotaSchema,
  spec: SpecSchema,
  review: ReviewSchema,
  testWriter: TestWriterSchema,
  scribe: ScribeSchema,
  codex: CodexSchema,
  observability: ObservabilitySchema,
  dependencies: DependenciesSchema,
  git: GitSchema,
  /** Consecutive task failures before the run aborts. */
  maxConsecutiveFailures: external_exports.number().int().positive().default(3),
  /** Hard wall-clock cap for a whole run, minutes. */
  maxRuntimeMinutes: external_exports.number().int().positive().default(480)
}).default({});

// src/config/load.ts
var log2 = createLogger("config");
var PLUGIN_NAME = "factory";
var warnedRedirects = /* @__PURE__ */ new Set();
function expectedDataDir(opts) {
  const { current, home, pluginRoot, warn } = opts;
  if (!current) return null;
  const dataRoot = join2(home, ".claude", "plugins", "data");
  if (!current.startsWith(dataRoot + sep)) return null;
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
  if (existsSync(marketplaceJson)) {
    try {
      const parsed = parseJson(
        readFileSync(marketplaceJson, "utf8"),
        marketplaceJson
      );
      const marketplaceName = typeof parsed.name === "string" ? parsed.name : "";
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
      if (existsSync(join2(dir, ".claude-plugin"))) return dir;
      dir = dirname2(dir);
    }
    return resolve(here, "..");
  } catch {
    return process.cwd();
  }
}
function resolvePluginRoot(env = process.env) {
  const fromEnv = env.CLAUDE_PLUGIN_ROOT;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return resolve(fromEnv);
  return inferPluginRoot();
}
function resolveDataDir(opts = {}) {
  if (opts.dataDir) return resolve(opts.dataDir);
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const pluginRoot = opts.pluginRoot ?? inferPluginRoot();
  const current = env.CLAUDE_PLUGIN_DATA;
  const warn = opts.warn ?? ((m) => log2.warn(m));
  const corrected = expectedDataDir({ current, home, pluginRoot, warn });
  if (corrected && corrected !== current) {
    const key = JSON.stringify([current ?? "", corrected]);
    if (!warnedRedirects.has(key)) {
      warnedRedirects.add(key);
      warn(
        `CLAUDE_PLUGIN_DATA is set to '${current ?? ""}', which belongs to another plugin \u2014 factory auto-redirected to its canonical data dir '${corrected}'. This is benign and self-corrected: no action is required for correctness. To silence this warning permanently, set CLAUDE_PLUGIN_DATA to factory's own dir (e.g. export CLAUDE_PLUGIN_DATA="$HOME/.claude/plugins/data/factory-<your-marketplace-id>").`
      );
    }
    return resolve(corrected);
  }
  if (!current) {
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
  if (!existsSync(file)) {
    return ConfigSchema.parse({});
  }
  const raw = parseJson(readFileSync(file, "utf8"), file);
  return ConfigSchema.parse(raw);
}

// src/config/save.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { mkdir as mkdir2 } from "node:fs/promises";
function readRawConfig(opts = {}) {
  const file = configPath(resolveDataDir(opts));
  if (!existsSync2(file)) return {};
  const parsed = parseJson(readFileSync2(file, "utf8"), file);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config: ${file} is not a JSON object`);
  }
  return parsed;
}
async function saveRawConfig(raw, opts = {}) {
  const resolved = ConfigSchema.parse(raw);
  const dataDir = resolveDataDir(opts);
  await mkdir2(dataDir, { recursive: true });
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
    const key = path3[i];
    const existing = cursor[key];
    if (existing === void 0 || existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[path3[path3.length - 1]] = value;
  return next;
}
function unsetAtPath(obj, path3) {
  const next = structuredClone(obj);
  const parents = [];
  let cursor = next;
  for (let i = 0; i < path3.length - 1; i++) {
    const key = path3[i];
    const child = cursor[key];
    if (child === void 0 || child === null || typeof child !== "object" || Array.isArray(child)) {
      return next;
    }
    parents.push({ container: cursor, key });
    cursor = child;
  }
  delete cursor[path3[path3.length - 1]];
  for (let i = parents.length - 1; i >= 0; i--) {
    const { container, key } = parents[i];
    const child = container[key];
    if (Object.keys(child).length === 0) {
      delete container[key];
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

// src/core/state/schema.ts
var RunStatusEnum = external_exports.enum([
  "running",
  "completed",
  "superseded",
  "paused",
  "suspended",
  "failed"
]);
var TERMINAL_RUN_STATUSES = ["completed", "failed", "superseded"];
function isTerminalRunStatus(s) {
  return TERMINAL_RUN_STATUSES.includes(s);
}
var TaskStatusEnum = external_exports.enum([
  "pending",
  "executing",
  "reviewing",
  "shipping",
  "done",
  "dropped"
]);
var TERMINAL_TASK_STATUSES = ["done", "dropped"];
function isTerminalTaskStatus(s) {
  return TERMINAL_TASK_STATUSES.includes(s);
}
var FailureClassEnum = external_exports.enum([
  "capability-budget",
  "spec-defect",
  "blocked-environmental"
]);
var RiskTierEnum = external_exports.enum(["low", "medium", "high"]);
var EscalationRungSchema = external_exports.number().int().min(0);
var PanelVerdictEnum = external_exports.enum(["approve", "blocked", "error"]);
var ProducerRoleEnum = external_exports.enum(["test-writer", "executor"]);
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
var TaskStateSchema = external_exports.object({
  task_id: external_exports.string().min(1),
  status: TaskStatusEnum.default("pending"),
  /** Task ids this task depends on (the vertical-slice DAG, Decision 23). */
  depends_on: external_exports.array(external_exports.string()).default([]),
  // --- Producer dial + ladder (Decision 25) ---
  /** The single producer dial, set at spec time and never re-assessed mid-run. */
  risk_tier: RiskTierEnum,
  /** Current rung on the producer escalation ladder (0 = starting rung). */
  escalation_rung: EscalationRungSchema.default(0),
  /** Which producer role is/last ran. */
  producer_role: ProducerRoleEnum.optional(),
  // --- Verifier floor (Decision 26/27) ---
  /** Per-reviewer panel results (derive.ts computes the floor verdict from these). */
  reviewers: external_exports.array(ReviewerResultSchema).default([]),
  // --- Git / PR pointers (WS3 populates; schema reserves the shape) ---
  /** Run-scoped branch `factory/<run_id>/<task_id>` (Δ M). */
  branch: external_exports.string().optional(),
  /** PR number once created (idempotent-create keyed off branch, Δ P). */
  pr_number: external_exports.number().int().positive().optional(),
  // --- Drop classification (Decision 22, Δ D) ---
  /** Set IFF status === "dropped": the closed-enum cause. */
  failure_class: FailureClassEnum.optional(),
  /** Human-facing reason string accompanying a drop. */
  failure_reason: external_exports.string().optional(),
  /**
   * The precise resume cursor for the drive coroutine — which TaskStage the task is
   * at/resuming at. Written by markInFlight. Lossy `status` stays the human-facing
   * summary; `stage` is the machine cursor. Absent = not started (preflight).
   * NOTE: on terminal rows (done/dropped), `stage` is the last in-flight stage,
   * not a resume point — terminal writers do not clear it.
   * NOTE: literals duplicate stage-machine's TASK_STAGE_ORDER because core/state
   * must not import stage-machine (dependency direction) — a cross-check test in
   * src/driver/coroutine.test.ts pins them equal.
   */
  stage: external_exports.enum(["preflight", "tests", "exec", "verify", "ship"]).optional(),
  /** Ship live-merge re-sync count (cap enforced by the coroutine; persisted so the cap survives process boundaries). */
  merge_resyncs: external_exports.number().int().min(0).default(0),
  // --- Lifecycle timestamps (ISO-8601) ---
  started_at: external_exports.string().optional(),
  ended_at: external_exports.string().optional()
});
function refineTaskCrossFields(task, ctx) {
  const isDropped = task.status === "dropped";
  if (isDropped && task.failure_class == null) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["failure_class"],
      message: `task '${task.task_id}' is 'dropped' but has no failure_class (a drop must be classified)`
    });
  }
  if (!isDropped && task.failure_class != null) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["failure_class"],
      message: `task '${task.task_id}' has failure_class '${task.failure_class}' but status is '${task.status}' (failure_class is set IFF dropped)`
    });
  }
  const hasReason = task.failure_reason != null && task.failure_reason.length > 0;
  if (isDropped && !hasReason) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["failure_reason"],
      message: `task '${task.task_id}' is 'dropped' but has no failure_reason (a drop must carry a human-facing reason)`
    });
  }
  if (!isDropped && task.failure_reason != null) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["failure_reason"],
      message: `task '${task.task_id}' has a failure_reason but status is '${task.status}' (failure_reason is set IFF dropped)`
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
}
var TaskStateChecked = TaskStateSchema.superRefine(refineTaskCrossFields);
var QuotaCheckpointSchema = external_exports.object({
  /** Epoch (seconds) when the binding window resets — the resume horizon. */
  resets_at_epoch: external_exports.number().int().nonnegative().optional(),
  /** Which window forced the last pause/suspend, if any. */
  binding_window: external_exports.enum(["5h", "7d"]).optional()
});
var DriverEnum = external_exports.enum(["sequential", "balanced"]);
var RunModeEnum = external_exports.enum(["session", "workflow"]);
var ShipModeEnum = external_exports.enum(["no-merge", "live"]);
var RunStateSchema = external_exports.object({
  /** State-schema version (independent of plugin version). */
  schema_version: external_exports.literal(1).default(1),
  /** `run-YYYYMMDD-HHMMSS`. */
  run_id: external_exports.string().min(1),
  status: RunStatusEnum.default("running"),
  driver: DriverEnum.default("sequential"),
  mode: RunModeEnum.default("session"),
  ship_mode: ShipModeEnum.default("live"),
  /**
   * The Claude Code session id that OWNS this run (Prompt J — session-scoped Stop
   * gate). Stamped ONCE at `run create` from the launching session's
   * `CLAUDE_CODE_SESSION_ID` (the orchestrator/Bash env), so the Stop hook can
   * session-scope its block: only the OWNING session is gated; an unrelated session
   * stopping while this run is live passes through. Optional — best-effort: when the
   * env var is absent (owner unknown), the Stop gate falls back to the unscoped
   * behavior (degraded but safe). An immutable property, never a derived verdict.
   */
  owner_session: external_exports.string().min(1).optional(),
  /**
   * The per-run staging branch this run cut + pushed (`staging-<run-id>`). PINNED
   * ONCE at `run create` (Decision 33) so every later base-ref resolution — worktree
   * fork point, deterministic-gate diff base, reviewer/holdout inspect ref, ship
   * merge target, rollup source — reads the branch the run ACTUALLY created, not a
   * value recomputed by `runStagingBranch(run_id)`. A mid-run naming-scheme change
   * (e.g. the slashed→flat rename) would otherwise silently desync the recompute from
   * the already-pushed branch. Optional for backward-compat: legacy runs predating the
   * pin lack it; readers fall back to `runStagingBranch(run_id)` via `resolveStagingBranch`.
   * Git provenance / immutable identity — NOT a derived verdict, so derive-don't-store
   * does not apply.
   */
  staging_branch: external_exports.string().min(1).optional(),
  /** Pointer to the durable spec (Δ X) — NOT an embedded spec. */
  spec: SpecPointerSchema,
  /** Per-task state, keyed by task_id (cross-field checks applied per task). */
  tasks: external_exports.record(external_exports.string(), TaskStateChecked).default({}),
  /** Quota resume checkpoint (Decision 24); absent until a pause/suspend. */
  quota: QuotaCheckpointSchema.optional(),
  /** Lifecycle timestamps (ISO-8601). */
  started_at: external_exports.string(),
  updated_at: external_exports.string(),
  ended_at: external_exports.string().nullable().default(null)
});
function refineRunCrossFields(run9, ctx) {
  const quotaStatuses = ["paused", "suspended"];
  if (run9.quota != null && !quotaStatuses.includes(run9.status)) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      path: ["quota"],
      message: `run '${run9.run_id}' carries a quota checkpoint but status is '${run9.status}' (a quota checkpoint is valid only while paused|suspended)`
    });
  }
}
var RunStateChecked = RunStateSchema.superRefine(refineRunCrossFields);
function parseRunState(raw) {
  return RunStateChecked.parse(raw);
}

// src/core/state/derive.ts
function deriveAllGatesVerdict(evidence) {
  const passed = evidence.length > 0 && evidence.every((e) => e.observed === true);
  return {
    passed,
    gate: "all",
    __derived: true,
    from: [...evidence]
  };
}
function derivePanelVerdict(reviewersOrTask) {
  const reviewers = Array.isArray(reviewersOrTask) ? reviewersOrTask : reviewersOrTask.reviewers;
  const passed = reviewers.length > 0 && reviewers.every((r) => r.verdict === "approve");
  return {
    passed,
    gate: "panel",
    __derived: true,
    // The panel's "evidence" is each reviewer's verdict; expose it for audit.
    from: reviewers.map((r) => ({
      gate: `panel:${r.reviewer}`,
      observed: r.verdict === "approve",
      detail: `verdict=${r.verdict} confirmed_blockers=${r.confirmed_blockers}`
    }))
  };
}
function deriveFloorVerdict(task, gateEvidence) {
  const det = deriveAllGatesVerdict(gateEvidence);
  const panel = derivePanelVerdict(task);
  return {
    passed: det.passed && panel.passed,
    gate: "floor",
    __derived: true,
    from: [...det.from, ...panel.from]
  };
}
function floorBlockReason(reviewers, gateEvidence) {
  const parts = [];
  if (gateEvidence.length === 0) {
    parts.push("no deterministic gate evidence");
  } else {
    const failed = gateEvidence.filter((g) => g.observed !== true);
    if (failed.length > 0) {
      const named = failed.map((g) => g.detail ? `${g.gate} (${g.detail})` : g.gate);
      parts.push(`failed gates: ${named.join(", ")}`);
    }
  }
  const blocked = reviewers.filter((r) => r.verdict === "blocked").map((r) => r.reviewer);
  const errored = reviewers.filter((r) => r.verdict === "error").map((r) => r.reviewer);
  if (blocked.length > 0) parts.push(`blocked by: ${blocked.join(", ")}`);
  if (errored.length > 0) parts.push(`unresolved (verifier error): ${errored.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "floor not unanimous";
}

// src/core/state/manager.ts
import { mkdir as mkdir4, readFile, readdir, rename as rename2, rm, symlink, unlink as unlink2 } from "node:fs/promises";
import { existsSync as existsSync4 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";

// src/shared/file-lock.ts
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import { mkdir as mkdir3 } from "node:fs/promises";
import { existsSync as existsSync3 } from "node:fs";
var log3 = createLogger("lock");
var DEFAULT_FILE_LOCK_TUNING = {
  stale: 15e3,
  // Enough attempts that ≥3 concurrent writers all eventually win their turn.
  retries: 50,
  retryMinTimeout: 20,
  retryMaxTimeout: 500
};
async function withFileLock(opts, fn) {
  if (opts.dirPolicy === "create") {
    await mkdir3(opts.dir, { recursive: true });
  } else if (!existsSync3(opts.dir)) {
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
      log3.error(`lock for ${opts.label} was compromised: ${err.message}`);
      throw err;
    }
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

// src/shared/time.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function nowEpoch() {
  return Math.floor(Date.now() / 1e3);
}

// src/core/state/paths.ts
import { join as join3 } from "node:path";

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
function makeRunId(now = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const date = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const time = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `run-${date}-${time}`;
}
function slugify(input) {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, SLUG_MAX_LENGTH);
}

// src/core/state/paths.ts
var SPECS_DIR = "specs";
var SPEC_BUILD_DIR = "spec-build";
var DOCS_FACTORY_DIR = "factory";
var RUNS_DIR = "runs";
var WORKTREES_DIR = "worktrees";
var CURRENT_LINK = "current";
var CURRENT_DIR = "current";
var STATE_FILE = "state.json";
var METRICS_FILE = "metrics.jsonl";
var REPORT_FILE = "report.md";
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
function worktreesRoot(dataDir) {
  return join3(dataDir, WORKTREES_DIR);
}
function runDir(dataDir, runId) {
  validateId(runId, "run-id");
  return join3(runsRoot(dataDir), runId);
}
function runStatePath(dataDir, runId) {
  return join3(runDir(dataDir, runId), STATE_FILE);
}
function runMetricsPath(dataDir, runId) {
  return join3(runDir(dataDir, runId), METRICS_FILE);
}
function runReportPath(dataDir, runId) {
  return join3(runDir(dataDir, runId), REPORT_FILE);
}
function currentLinkPath(dataDir) {
  return join3(runsRoot(dataDir), CURRENT_LINK);
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
function specBuildRoot(dataDir) {
  return join3(dataDir, SPEC_BUILD_DIR);
}
function specBuildDir(dataDir, repo, issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`specBuildDir: issue number must be a positive integer, got ${issueNumber}`);
  }
  return join3(specBuildRoot(dataDir), repoKey(repo), String(issueNumber));
}

// src/core/state/manager.ts
var log4 = createLogger("state");
var DEFAULT_LOCK_TUNING = DEFAULT_FILE_LOCK_TUNING;
var StateManager = class {
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
    return withFileLock(
      { dir, lockfile: lockfilePath, label, dirPolicy: "assert", tuning: this.lockTuning },
      fn
    );
  }
  /**
   * Run `fn` while holding the per-run lock. The lockfile's parent (the run dir)
   * must already exist — `create` mkdirs it before first lock; mutators lock an
   * existing run.
   */
  async withLock(runId, fn) {
    return this.runWithLock(
      runDir(this.dataDir, runId),
      this.lockfilePath(runId),
      `run '${runId}'`,
      fn
    );
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
   * state.json atomically under the lock, and (best-effort) points `runs/current`
   * at it. Refuses to clobber an existing run dir.
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
      driver: args.driver ?? "sequential",
      mode: args.mode ?? "session",
      ship_mode: args.ship_mode ?? "live",
      // Stamp the owning session only when known (best-effort) — an absent owner
      // leaves the field undefined and the Stop gate falls back to unscoped behavior.
      ...args.owner_session !== void 0 ? { owner_session: args.owner_session } : {},
      ...args.staging_branch !== void 0 ? { staging_branch: args.staging_branch } : {},
      spec: args.spec,
      tasks: {},
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
    const raw = await readFile(path3, "utf8");
    return parseRunState(parseJson(raw, path3));
  }
  /**
   * Read the run currently pointed at by `runs/current`, or null if there is no
   * current run. `current` is a directory symlink; we read `state.json` *through*
   * it (the OS follows the symlink during the path walk), so no separate readlink
   * is needed. LOUD on a corrupt/invalid current state.json — only genuine
   * ABSENCE (missing/dangling symlink → ENOENT) maps to null, matching read()'s
   * loud-on-corruption contract. Swallowing a ZodError/JSON error here would make
   * a corrupt active run indistinguishable from "no current run".
   */
  async readCurrent() {
    return this.readThroughLink(currentLinkPath(this.dataDir));
  }
  /**
   * Read the run the PER-REPO current pointer (`current/<repo-key>`, L2.7) names —
   * the authoritative pointer the human CLI resolves per checkout. A per-repo MISS
   * (no pointer for this repo yet) falls back to the legacy GLOBAL `runs/current`,
   * but ONLY adopts it when it belongs to the SAME repo — so a pre-upgrade in-flight
   * run (global-only) still resolves, while another repo's run never leaks in.
   * Loud on a corrupt state.json behind either pointer (same contract as readCurrent).
   */
  async readCurrentForRepo(repo) {
    const viaRepo = await this.readThroughLink(currentRepoLinkPath(this.dataDir, repo));
    if (viaRepo !== null) return viaRepo;
    const legacy = await this.readCurrent();
    return legacy !== null && legacy.spec.repo === repo ? legacy : null;
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
    if (!existsSync4(link)) return null;
    const statePath = join4(link, "state.json");
    let raw;
    try {
      raw = await readFile(statePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    return parseRunState(parseJson(raw, statePath));
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
  async listRuns() {
    let entries;
    try {
      entries = await readdir(runsRoot(this.dataDir), { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        runs.push(await this.read(entry.name));
      } catch (err) {
        if (err.code === "ENOENT") continue;
        log4.warn(`state: skipping unreadable run '${entry.name}': ${err.message}`);
      }
    }
    return runs.sort((a, b) => a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0);
  }
  /**
   * Find the newest NON-terminal run for `(repo, specId)`, or null. Powers the
   * resolve-or-reuse path of `run create`: a repeated create returns the live run
   * instead of spawning an orphan. Matches on BOTH repo and spec_id (a spec id is
   * `<issue>-<slug>` — unique within a repo, but not necessarily across repos).
   */
  async findActiveBySpec(repo, specId) {
    const runs = await this.listRuns();
    for (const r of runs) {
      if (r.spec.repo === repo && r.spec.spec_id === specId && !isTerminalRunStatus(r.status)) {
        return r;
      }
    }
    return null;
  }
  /**
   * ALL non-terminal runs owned by `session` (its `owner_session`), newest-first
   * (empty session → `[]`). The raw list behind {@link findActiveByOwner}: callers
   * that must DISTINGUISH "none owned" from "ambiguous (≥2 owned)" — e.g. `run cancel`,
   * which fails LOUD on ambiguity rather than guessing which run to abandon — branch
   * on `.length`.
   */
  async findAllActiveByOwner(session) {
    if (session.length === 0) return [];
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
    return owned.length === 1 ? owned[0] : null;
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
      const validated = parseRunState({ ...next, updated_at: nowIso() });
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
  // ---- finalize ----------------------------------------------------------
  /**
   * Finalize a run to a TERMINAL status (Decision 22/24 — finalize is terminal,
   * never spins). Refuses a non-terminal status. Stamps `ended_at`. Idempotent
   * for the same terminal status.
   */
  async finalize(runId, status) {
    if (!isTerminalRunStatus(status)) {
      throw new Error(
        `state: finalize requires a terminal status (completed|failed|superseded); got '${status}'`
      );
    }
    return this.update(runId, (state) => {
      if (isTerminalRunStatus(state.status) && state.status !== status) {
        throw new Error(
          `state: run '${runId}' already terminal as '${state.status}'; cannot re-finalize as '${status}'`
        );
      }
      return { ...state, status, quota: void 0, ended_at: state.ended_at ?? nowIso() };
    });
  }
  // ---- current symlink ---------------------------------------------------
  /**
   * Repoint the current pointers at a freshly-created run (L2.6/L2.7):
   *   - the PER-REPO pointer `current/<repo-key>` → `../runs/<run-id>` (authoritative
   *     for the human CLI per checkout), and
   *   - the legacy GLOBAL `runs/current` → `<run-id>` (the repo-less "most-recent"
   *     fallback the degraded hook/stop paths still read).
   *
   * CLOBBER GUARD (L2.6) — runs BEFORE any write and throws LOUD (NOT swallowed by the
   * best-effort symlink catch below): if THIS repo's current pointer already names a
   * still-live run owned by a DIFFERENT known session, refuse to hide it. Same-repo
   * concurrent runs by distinct sessions are thus serialized, while cross-repo creates
   * (a different repo's pointer) never trip it. The just-created run's `state.json`
   * already exists, so it stays addressable via `--run <id>` after the throw.
   * Degrades safe (no refusal) when either owner is unknown — today's last-wins behavior.
   */
  async pointCurrentAt(state) {
    const repo = state.spec.repo;
    const existing = await this.readCurrentForRepo(repo);
    if (existing !== null && existing.run_id !== state.run_id && !isTerminalRunStatus(existing.status) && existing.owner_session !== void 0 && state.owner_session !== void 0 && existing.owner_session !== state.owner_session) {
      throw new Error(
        `state: refusing to repoint current for repo '${repo}' \u2014 run '${existing.run_id}' is still live (owned by a different session '${existing.owner_session}'). Run '${state.run_id}' was created and is addressable via \`--run ${state.run_id}\`; finalize or rescue '${existing.run_id}' before starting a concurrent run in this repo.`
      );
    }
    await this.repointSymlink(
      currentRepoLinkPath(this.dataDir, repo),
      join4("..", RUNS_DIR, state.run_id)
    );
    await this.repointSymlink(currentLinkPath(this.dataDir), join4(state.run_id));
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
      log4.warn(
        `state: could not update current pointer '${link}' \u2192 '${target}': ${err.message}`
      );
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
    const list = values.get(name) ?? [];
    list.push(value);
    values.set(name, list);
  };
  let i = 0;
  let optionsEnded = false;
  while (i < argv.length) {
    const tok = argv[i];
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
function parseShipMode(raw) {
  if (raw === void 0) return void 0;
  const parsed = ShipModeEnum.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new UsageError(
    `unknown --ship-mode '${String(raw)}' (expected ${ShipModeEnum.options.join(" | ")})`
  );
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
function emitError(line) {
  process.stderr.write(line + "\n");
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
  factory configure --set git.stagingBranch=staging
  factory configure --set git.autoProvision=true`;
async function run(argv) {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
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
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`configure: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

// src/shared/exec.ts
import { spawn } from "node:child_process";
var DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
function exec(command, args = [], opts = {}) {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve2, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
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
      if (settled) return;
      settled = true;
      reject(err);
    };
    child.stdout?.on("data", (c) => {
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
    child.stderr?.on("data", (c) => {
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
      if (settled) return;
      settled = true;
      resolve2({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        code,
        signal: signal ?? null,
        truncated
      });
    });
    if (opts.input !== void 0 && child.stdin) {
      child.stdin.on("error", () => {
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

// src/shared/jsonl.ts
import { appendFile, mkdir as mkdir5, readFile as readFile2 } from "node:fs/promises";
import { dirname as dirname4 } from "node:path";
async function appendJsonl(path3, record) {
  await mkdir5(dirname4(path3), { recursive: true });
  await appendFile(path3, JSON.stringify(record) + "\n", "utf8");
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
  if (SECRET_REDACTION_PATTERNS.length === 0) return text;
  const combined = SECRET_REDACTION_PATTERNS.map((p) => p.source).join("|");
  const re = new RegExp(combined, "g");
  return text.replace(re, REDACTION_TOKEN);
}

// src/shared/paths.ts
function tildeShorten(absPath, home) {
  if (home.length === 0) return absPath;
  if (absPath === home) return "~";
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  if (absPath.startsWith(base + "/")) {
    return "~" + absPath.slice(base.length);
  }
  return absPath;
}

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
var log5 = createLogger("git");
var DefaultGitClient = class {
  runner;
  constructor(runner = defaultGitRunner) {
    this.runner = runner;
  }
  exec(args, opts) {
    const execOpts = opts?.cwd ? { cwd: opts.cwd } : {};
    return this.runner(args, execOpts);
  }
  execOrThrow(args, opts) {
    const execOpts = opts?.cwd ? { cwd: opts.cwd } : {};
    return runOrThrow("git", this.runner, args, execOpts);
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
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw new Error(`git show-ref failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
  }
  async checkoutB(branch, startPoint, opts) {
    log5.debug(`checkout -B ${branch} ${startPoint}`);
    await this.execOrThrow(["checkout", "-B", branch, startPoint], opts);
  }
  async currentBranch(opts) {
    const r = await this.execOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], opts);
    return r.stdout.trim();
  }
  async remoteUrl(remote, opts) {
    const r = await this.exec(["remote", "get-url", remote], opts);
    if (r.code !== 0) return null;
    const url = r.stdout.trim();
    return url.length > 0 ? url : null;
  }
  async lsRemoteHeads(remote, branch, opts) {
    const r = await this.execOrThrow(["ls-remote", "--heads", remote, branch], opts);
    const line = r.stdout.trim();
    if (line.length === 0) return null;
    const sha = line.split(/\s+/)[0];
    return sha && sha.length > 0 ? sha : null;
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
    if (opts?.setUpstream) args.push("-u");
    args.push(remote, branch);
    await this.execOrThrow(args, opts);
  }
  async mergeFfOrCommit(branch, ref, opts) {
    log5.debug(`merge --no-edit ${ref} into ${branch}`);
    await this.execOrThrow(["checkout", branch], opts);
    await this.execOrThrow(["merge", "--no-edit", ref], opts);
  }
};

// src/git/repo.ts
function parseRemoteUrl(url) {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  let path3;
  const scp = /^[^/@]+@[^/:]+:(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    path3 = scp[1];
  } else {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/.exec(trimmed);
    if (withScheme) {
      const afterScheme = withScheme[1];
      const firstSlash = afterScheme.indexOf("/");
      if (firstSlash >= 0) path3 = afterScheme.slice(firstSlash + 1);
    }
  }
  if (path3 === void 0) return null;
  let p = path3.replace(/\/+$/, "");
  p = p.replace(/\.git$/i, "");
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const name = segments[segments.length - 1];
  const owner = segments[segments.length - 2];
  if (owner.length === 0 || name.length === 0) return null;
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
  return { owner: parts[0], repo: parts[1] };
}
async function resolveRepo(args) {
  const remote = args.remote ?? "origin";
  const explicit = typeof args.explicit === "string" && args.explicit.length > 0 ? validateRepoSlug(args.explicit) : void 0;
  const derived = await deriveRepo(args.gitClient, remote, args.cwd);
  if (explicit !== void 0) {
    if (derived === null) return explicit;
    if (explicit.toLowerCase() === derived.toLowerCase()) return derived;
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
  if (url === null) return null;
  return parseRemoteUrl(url);
}

// src/git/gh-client.ts
var log6 = createLogger("gh");
var PullRequestSchema = external_exports.object({
  number: external_exports.number().int(),
  headRefName: external_exports.string(),
  baseRefName: external_exports.string(),
  state: external_exports.enum(["OPEN", "CLOSED", "MERGED"]),
  mergeable: external_exports.string().optional(),
  mergeStateStatus: external_exports.string().optional(),
  url: external_exports.string().optional()
});
var REQUIRED_VIEW_FIELDS = Object.entries(PullRequestSchema.shape).filter(([, schema]) => !schema.isOptional()).map(([key]) => key);
function aggregateChecks(rows) {
  if (rows.length === 0) return "none";
  const buckets = rows.map((r) => (r.bucket ?? "").toLowerCase());
  if (buckets.some((b) => b === "fail" || b === "cancel")) return "failing";
  if (buckets.some((b) => b === "pending")) return "pending";
  return "passing";
}
function parseGhJson(result, schema, where) {
  if (result.truncated) {
    throw new Error(
      `gh: output of '${where}' was TRUNCATED (hit maxBuffer) \u2014 refusing to parse a clipped JSON payload`
    );
  }
  const raw = parseJson(result.stdout, where);
  return schema.parse(raw);
}
var DefaultGhClient = class {
  runner;
  constructor(runner = defaultGhRunner) {
    this.runner = runner;
  }
  execOpts(opts) {
    return opts?.cwd ? { cwd: opts.cwd } : {};
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
      "number,headRefName,baseRefName,state,mergeable,mergeStateStatus,url"
    ];
    if (args.base) argv.push("--base", args.base);
    const r = await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
    return parseGhJson(r, external_exports.array(PullRequestSchema), "gh pr list");
  }
  async prCreate(args, opts) {
    const r = await runOrThrow(
      "gh",
      this.runner,
      [
        "pr",
        "create",
        "--base",
        args.base,
        "--head",
        args.head,
        "--title",
        args.title,
        "--body",
        args.body
      ],
      this.execOpts(opts)
    );
    if (r.truncated) {
      throw new Error("gh pr create: output truncated \u2014 cannot trust the emitted PR URL");
    }
    const url = r.stdout.trim().split(/\s+/).pop() ?? "";
    const m = url.match(/\/pull\/(\d+)\s*$/);
    if (!m) {
      throw new Error(`gh pr create: could not parse PR number from output: ${r.stdout.trim()}`);
    }
    return { number: Number(m[1]), url };
  }
  async issueCreate(args, opts) {
    const argv = ["issue", "create", "--title", args.title, "--body", args.body];
    if (args.repo) argv.push("--repo", args.repo);
    for (const label of args.labels ?? []) argv.push("--label", label);
    const r = await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
    if (r.truncated) {
      throw new Error("gh issue create: output truncated \u2014 cannot trust the emitted issue URL");
    }
    const url = r.stdout.trim().split(/\s+/).pop() ?? "";
    const m = url.match(/\/issues\/(\d+)\s*$/);
    if (!m) {
      throw new Error(
        `gh issue create: could not parse issue number from output: ${r.stdout.trim()}`
      );
    }
    return { number: Number(m[1]), url };
  }
  async issueList(args, opts) {
    const argv = [
      "issue",
      "list",
      "--json",
      "number,title",
      "--limit",
      "200",
      "--state",
      args.state ?? "open"
    ];
    if (args.repo) argv.push("--repo", args.repo);
    for (const label of args.labels ?? []) argv.push("--label", label);
    const r = await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
    return parseGhJson(
      r,
      external_exports.array(external_exports.object({ number: external_exports.number().int(), title: external_exports.string() })),
      "gh issue list"
    );
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
    const r = await this.runner(
      ["pr", "checks", String(number), "--json", "bucket"],
      this.execOpts(opts)
    );
    if (r.truncated) {
      throw new Error("gh pr checks: output truncated \u2014 refusing to parse clipped checks JSON");
    }
    const stdout = r.stdout.trim();
    if (stdout === "" || stdout === "[]") {
      if (r.code !== 0 && !/no checks reported/i.test(r.stderr)) {
        throw new Error(
          `gh pr checks #${number} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`
        );
      }
      return "none";
    }
    const rows = parseJson(stdout, "gh pr checks");
    return aggregateChecks(rows);
  }
  async prMergeSquash(number, opts) {
    const argv = ["pr", "merge", String(number), "--squash"];
    if (opts?.auto) argv.push("--auto");
    if (opts?.deleteBranch) argv.push("--delete-branch");
    if (opts?.subject !== void 0) argv.push("--subject", opts.subject);
    if (opts?.body !== void 0) argv.push("--body", opts.body);
    await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
  }
  async deleteRemoteBranch(owner, repo, branch, opts) {
    const path3 = `repos/${owner}/${repo}/git/refs/heads/${branch}`;
    const r = await this.runner(["api", "--method", "DELETE", path3], this.execOpts(opts));
    if (r.code !== 0 && !/Reference does not exist|404|Not Found|422/i.test(r.stderr)) {
      throw new Error(
        `gh api DELETE ${path3} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`
      );
    }
  }
  async deleteProtection(owner, repo, branch, opts) {
    const argv = ["api", "-X", "DELETE", `/repos/${owner}/${repo}/branches/${branch}/protection`];
    const r = await this.runner(argv, this.execOpts(opts));
    if (r.code !== 0 && !/404|Not Found|Branch not protected/i.test(r.stderr)) {
      throw new Error(
        `gh api DELETE protection failed for ${owner}/${repo}@${branch}: ${r.stderr}`
      );
    }
  }
  async issueComment(args, opts) {
    const argv = [
      "issue",
      "comment",
      String(args.number),
      "--repo",
      args.repo,
      "--body",
      args.body
    ];
    await runOrThrow("gh", this.runner, argv, this.execOpts(opts));
  }
  async issueClose(args, opts) {
    const argv = ["issue", "close", String(args.number), "--repo", args.repo];
    if (args.comment !== void 0) argv.push("--comment", args.comment);
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
      throw new Error(`gh api ${path3} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
    }
    if (r.truncated) {
      throw new Error(
        `gh api ${path3}: output truncated \u2014 refusing to parse clipped protection JSON`
      );
    }
    const raw = parseJson(r.stdout, path3);
    const rsc = raw.required_status_checks ?? null;
    const mq = await this.mergeQueueProbe(owner, repo, branch, opts);
    return {
      enabled: true,
      requiredStatusChecks: rsc?.contexts ?? [],
      strictUpToDate: rsc?.strict === true,
      hasMergeQueue: mq
    };
  }
  async putProtection(owner, repo, branch, body, opts) {
    const path3 = `repos/${owner}/${repo}/branches/${branch}/protection`;
    const payload = JSON.stringify({
      required_status_checks: {
        strict: body.strict,
        contexts: body.requiredStatusChecks
      },
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null
    });
    log6.info(`provisioning branch protection for ${owner}/${repo}@${branch}`);
    await runOrThrow("gh", this.runner, ["api", "--method", "PUT", path3, "--input", "-"], {
      ...this.execOpts(opts),
      input: payload
    });
  }
  async mergeQueueProbe(owner, repo, branch, opts) {
    const path3 = `repos/${owner}/${repo}/rules/branches/${branch}`;
    const r = await this.runner(["api", path3], this.execOpts(opts));
    if (r.code !== 0 || r.truncated) return false;
    try {
      const rules = parseJson(r.stdout, path3);
      return Array.isArray(rules) && rules.some((rule) => rule.type === "merge_queue");
    } catch {
      return false;
    }
  }
};

// src/git/rollup.ts
var log7 = createLogger("git");
var GIT_DEFAULTS = GitSchema.parse({});
var DEFAULT_POLL_INTERVAL_MS = 15e3;
var DEFAULT_MAX_POLLS = 80;
var realSleep = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));
async function waitForCi(gh, number, args) {
  const sleep = args.sleep ?? realSleep;
  const interval = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPolls = args.maxPolls ?? DEFAULT_MAX_POLLS;
  let state = "pending";
  for (let i = 0; i < maxPolls; i++) {
    state = await gh.prChecks(number);
    if (state !== "pending") return state;
    if (i < maxPolls - 1) await sleep(interval);
  }
  return state;
}
async function rollup(args) {
  const staging = args.stagingBranch ?? GIT_DEFAULTS.stagingBranch;
  const base = args.baseBranch ?? GIT_DEFAULTS.baseBranch;
  if (base === "main") {
    throw new Error(
      "rollup: baseBranch must not be 'main' (Decision 16 \u2014 the factory never touches main)"
    );
  }
  const subject = args.title;
  const existing = await args.ghClient.prList({ head: staging, base, state: "all" });
  const merged = existing.find((p) => p.state === "MERGED");
  if (merged) {
    log7.info(`rollup PR #${merged.number} already merged into ${base} \u2014 finalize resuming`);
    return { number: merged.number, url: merged.url ?? "", resumed: true, merged: true, subject };
  }
  const open2 = existing.find((p) => p.state === "OPEN");
  let number;
  let url;
  let resumed;
  if (open2) {
    log7.info(`resuming rollup PR #${open2.number} (${staging}\u2192${base})`);
    number = open2.number;
    url = open2.url ?? "";
    resumed = true;
  } else {
    const created = await args.ghClient.prCreate({
      base,
      head: staging,
      title: args.title,
      body: args.body
    });
    log7.info(`opened rollup PR #${created.number} (${staging}\u2192${base})`);
    number = created.number;
    url = created.url;
    resumed = false;
  }
  if (!args.merge) {
    log7.info(`rollup PR #${number}: no-merge mode \u2014 opened, not merged`);
    return { number, url, resumed, merged: false, reason: "no-merge" };
  }
  const ci = await waitForCi(args.ghClient, number, args);
  if (ci === "failing") {
    log7.warn(`rollup PR #${number}: CI failing \u2014 not merged`);
    return { number, url, resumed, merged: false, reason: "ci-failing", ci };
  }
  if (ci === "pending") {
    log7.warn(
      `rollup PR #${number}: CI still pending after ${args.maxPolls ?? DEFAULT_MAX_POLLS} polls \u2014 not merged`
    );
    return { number, url, resumed, merged: false, reason: "ci-timeout", ci };
  }
  const view = await args.ghClient.prView(number, [
    "number",
    "state",
    "mergeable",
    "mergeStateStatus"
  ]);
  if (view.state === "MERGED") {
    return { number, url, resumed, merged: true, subject, ci };
  }
  if (view.mergeable === "CONFLICTING") {
    log7.warn(`rollup PR #${number} is CONFLICTING \u2014 not merged`);
    return { number, url, resumed, merged: false, reason: "not-mergeable", ci };
  }
  await args.ghClient.prMergeSquash(number, { subject, body: args.body });
  log7.info(`rollup PR #${number} squash-merged into ${base}`);
  return { number, url, resumed, merged: true, subject, ci };
}

// src/git/branch.ts
var DEFAULT_PREFIX = GitSchema.parse({}).branchPrefix;
function runScopedBranch(runId, taskId, prefix = DEFAULT_PREFIX) {
  validateId(runId, "run-id");
  validateId(taskId, "task-id");
  if (prefix.length === 0 || prefix.includes("/")) {
    throw new Error(`branch: invalid prefix '${prefix}' (non-empty, no '/')`);
  }
  return `${prefix}/${runId}/${taskId}`;
}

// src/git/worktree.ts
var log8 = createLogger("git");
var GIT_DEFAULTS2 = GitSchema.parse({});
async function createTaskWorktree(args) {
  const remote = args.remote ?? "origin";
  const base = args.base ?? GIT_DEFAULTS2.stagingBranch;
  const branch = runScopedBranch(args.runId, args.taskId);
  const startPoint = `${remote}/${base}`;
  await args.gitClient.fetch(remote, base);
  if (await args.gitClient.worktreeExists(args.path)) {
    await ensureOnStaging({ gitClient: args.gitClient, path: args.path, branch, remote, base });
  } else {
    await args.gitClient.worktreeAdd(["-b", branch, args.path, startPoint]);
  }
  await assertBaseIsStagingTip({
    gitClient: args.gitClient,
    path: args.path,
    remote,
    base
  });
  return { path: args.path, branch, startPoint };
}
async function assertBaseIsStagingTip(args) {
  const remote = args.remote ?? "origin";
  const base = args.base ?? GIT_DEFAULTS2.stagingBranch;
  const opts = { cwd: args.path };
  const stagingTip = await args.gitClient.revParse(`${remote}/${base}`, opts);
  const mergeBase = await args.gitClient.mergeBase("HEAD", `${remote}/${base}`, opts);
  if (mergeBase !== stagingTip) {
    throw new Error(
      `worktree base drift: merge-base(HEAD, ${remote}/${base})=${mergeBase} != ${remote}/${base} tip=${stagingTip} \u2014 worktree did not birth on the staging tip (D12 invariant #4)`
    );
  }
}
async function ensureOnStaging(args) {
  const remote = args.remote ?? "origin";
  const base = args.base ?? GIT_DEFAULTS2.stagingBranch;
  const opts = { cwd: args.path };
  log8.debug(`ensureOnStaging: checkout -B ${args.branch} ${remote}/${base}`);
  await args.gitClient.checkoutB(args.branch, `${remote}/${base}`, opts);
}

// src/git/provision.ts
import { access } from "node:fs/promises";
import path from "node:path";
var log9 = createLogger("provision");
var LOCKFILE_INSTALL = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["package-lock.json", "npm ci"],
  ["npm-shrinkwrap.json", "npm ci"]
];
async function defaultFileExists(absPath) {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}
async function defaultRun(command, cwd) {
  const r = await exec(command, [], { cwd, shell: true });
  return { code: r.code, stderr: r.stderr };
}
async function resolveSetupCommand(worktreePath, setupCommand, fileExists) {
  if (setupCommand !== void 0 && setupCommand.trim().length > 0) return setupCommand;
  for (const [lockfile, command] of LOCKFILE_INSTALL) {
    if (await fileExists(path.join(worktreePath, lockfile))) return command;
  }
  return null;
}
async function provisionWorktree(args) {
  const fileExists = args.fileExists ?? defaultFileExists;
  const run9 = args.run ?? defaultRun;
  const command = await resolveSetupCommand(args.path, args.setupCommand, fileExists);
  if (command === null) {
    log9.debug(`no setupCommand and no lockfile in ${args.path} \u2014 skipping worktree provisioning`);
    return;
  }
  log9.info(`provisioning worktree: ${command} (cwd=${args.path})`);
  const res = await run9(command, args.path);
  if (res.code !== 0) {
    const detail = res.stderr.trim();
    throw new Error(
      `worktree provisioning failed: \`${command}\` exited ${res.code ?? "null"} in ${args.path}` + (detail.length > 0 ? `
${detail}` : "")
    );
  }
}

// src/git/pr.ts
var log10 = createLogger("git");
var GIT_DEFAULTS3 = GitSchema.parse({});
async function createTaskPrIdempotent(args) {
  const base = args.base ?? GIT_DEFAULTS3.stagingBranch;
  const existing = await args.ghClient.prList({ head: args.branch, base, state: "all" });
  const pr = existing.find((p) => p.state === "OPEN") ?? existing.find((p) => p.state === "MERGED");
  if (pr !== void 0) {
    log10.info(
      `resuming existing PR #${pr.number} (${pr.state}) for head '${args.branch}' (no duplicate created)`
    );
    return { number: pr.number, url: pr.url ?? "", resumed: true };
  }
  const created = await args.ghClient.prCreate({
    base,
    head: args.branch,
    title: args.title,
    body: args.body
  });
  log10.info(`created PR #${created.number} for head '${args.branch}'`);
  return { number: created.number, url: created.url, resumed: false };
}

// src/git/serial-writer.ts
import { join as join5 } from "node:path";
var log11 = createLogger("git");
var GIT_DEFAULTS4 = GitSchema.parse({});
var MERGE_LOCK_DEFAULTS = {
  ...DEFAULT_FILE_LOCK_TUNING,
  stale: 3e4,
  retries: 100,
  retryMinTimeout: 25,
  retryMaxTimeout: 1e3
};
var MergeSerializer = class {
  ghClient;
  owner;
  repo;
  staging;
  dataDir;
  lockScope;
  tuning;
  constructor(opts) {
    this.ghClient = opts.ghClient;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.staging = opts.stagingBranch ?? GIT_DEFAULTS4.stagingBranch;
    this.dataDir = resolveDataDir(opts);
    this.lockScope = opts.lockScope ?? `${opts.owner}__${opts.repo}__${this.staging}`.replace(/[^\w.-]/g, "-");
    this.tuning = { ...MERGE_LOCK_DEFAULTS, ...opts.lock ?? {} };
  }
  lockfilePath() {
    return join5(this.dataDir, "locks", `merge-${this.lockScope}.lock`);
  }
  /** Run `fn` while holding the app-level merge lock (the serial section). */
  async withMergeLock(fn) {
    return withFileLock(
      {
        dir: join5(this.dataDir, "locks"),
        lockfile: this.lockfilePath(),
        label: `merge '${this.lockScope}'`,
        dirPolicy: "create",
        tuning: this.tuning
      },
      fn
    );
  }
  /**
   * Serial-merge one task PR into staging. Acquires the app-level lock, RE-VERIFIES
   * mergeable + up-to-date against the CURRENT staging tip (so the 2nd of two
   * queued merges re-checks against the post-first-merge state), then either
   * enqueues via native merge-queue (probe upgrade) or squash-merges now. NEVER
   * arms N concurrent `--auto`.
   */
  async merge(prNumber) {
    return this.withMergeLock(async () => {
      const pr = await this.ghClient.prView(prNumber, [
        "number",
        "headRefName",
        "baseRefName",
        "state",
        "mergeable",
        "mergeStateStatus"
      ]);
      if (pr.state === "MERGED") {
        log11.info(`PR #${prNumber} already MERGED into ${this.staging} \u2014 ship resuming`);
        await this.ghClient.deleteRemoteBranch(this.owner, this.repo, pr.headRefName);
        return { merged: true, via: "app-level", number: prNumber };
      }
      if (pr.mergeable === "CONFLICTING") {
        log11.warn(`PR #${prNumber} is CONFLICTING \u2014 not merged`);
        return { merged: false, reason: "not-mergeable", number: prNumber };
      }
      if (pr.mergeStateStatus === "BEHIND") {
        log11.warn(
          `PR #${prNumber} head is BEHIND ${this.staging} \u2014 refusing to merge (no force-push)`
        );
        return { merged: false, reason: "behind", number: prNumber };
      }
      const hasMergeQueue = await this.ghClient.mergeQueueProbe(
        this.owner,
        this.repo,
        this.staging
      );
      if (hasMergeQueue) {
        await this.ghClient.prMergeSquash(prNumber, { auto: true, deleteBranch: true });
        log11.info(`PR #${prNumber} enqueued via native merge-queue`);
        return { merged: true, via: "merge-queue", number: prNumber };
      }
      await this.ghClient.prMergeSquash(prNumber, {});
      log11.info(`PR #${prNumber} squash-merged into ${this.staging} (app-level serial)`);
      await this.ghClient.deleteRemoteBranch(this.owner, this.repo, pr.headRefName);
      return { merged: true, via: "app-level", number: prNumber };
    });
  }
};

// src/git/protection.ts
var log12 = createLogger("git");
var GIT_DEFAULTS5 = GitSchema.parse({});
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
  const branch = args.branch ?? GIT_DEFAULTS5.stagingBranch;
  const result = await args.ghClient.repoProtection(
    args.owner,
    args.repo,
    branch
  );
  return {
    enabled: result.enabled,
    requiredStatusChecks: result.requiredStatusChecks,
    strictUpToDate: result.strictUpToDate,
    hasMergeQueue: result.hasMergeQueue
  };
}
function requireProtectionOrRefuse(state, requiredChecks, branch = GIT_DEFAULTS5.stagingBranch) {
  const reasons = [];
  if (!state.enabled) {
    reasons.push("no branch protection is configured");
  }
  if (!state.strictUpToDate) {
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
  const branch = args.branch ?? GIT_DEFAULTS5.stagingBranch;
  if (!args.provision) {
    throw new Error(
      "provisionProtection called without --provision opt-in \u2014 refusing to mutate branch protection"
    );
  }
  log12.info(`--provision: writing branch protection for ${args.owner}/${args.repo}@${branch}`);
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

// src/git/staging.ts
var log13 = createLogger("git");
var GIT_DEFAULTS6 = GitSchema.parse({});
async function ensureStaging(args) {
  const remote = args.remote ?? "origin";
  const staging = args.stagingBranch ?? GIT_DEFAULTS6.stagingBranch;
  const base = args.baseBranch ?? GIT_DEFAULTS6.baseBranch;
  if (base === "main") {
    throw new Error(
      "staging: baseBranch must not be 'main' (Decision 16 \u2014 the factory never touches main)"
    );
  }
  await args.gitClient.fetch(remote, base);
  const stagingHead = await args.gitClient.lsRemoteHeads(remote, staging);
  if (stagingHead === null) {
    const baseHead = await args.gitClient.lsRemoteHeads(remote, base);
    if (baseHead === null) {
      throw new Error(
        `staging: base branch '${remote}/${base}' does not exist \u2014 cannot create staging`
      );
    }
    log13.info(`creating ${staging} from ${remote}/${base}`);
    await args.gitClient.checkoutB(staging, `${remote}/${base}`, { cwd: args.cwd });
    await args.gitClient.push(remote, staging, { setUpstream: true, cwd: args.cwd });
    return { created: true, stagingTip: baseHead };
  }
  await args.gitClient.fetch(remote, staging);
  const baseTip = await args.gitClient.revParse(`${remote}/${base}`, { cwd: args.cwd });
  const stagingTip = await args.gitClient.revParse(`${remote}/${staging}`, { cwd: args.cwd });
  if (baseTip === stagingTip) {
    return { created: false, stagingTip };
  }
  const mergeBase = await args.gitClient.mergeBase(`${remote}/${base}`, `${remote}/${staging}`, {
    cwd: args.cwd
  });
  if (mergeBase === stagingTip) {
    log13.info(`fast-forwarding ${staging} to ${remote}/${base}`);
    await args.gitClient.checkoutB(staging, `${remote}/${base}`, { cwd: args.cwd });
    await args.gitClient.push(remote, staging, { cwd: args.cwd });
    return { created: false, stagingTip: baseTip };
  }
  if (mergeBase === baseTip) {
    return { created: false, stagingTip };
  }
  throw new Error(
    `staging: ${remote}/${staging} and ${remote}/${base} have DIVERGED (merge-base=${mergeBase}, staging=${stagingTip}, base=${baseTip}) \u2014 refusing to reconcile (no silent main fallback)`
  );
}

// src/git/run-staging.ts
var RUN_STAGING_PREFIX = "staging";
function runStagingBranch(runId) {
  if (runId.length === 0) {
    throw new Error("runStagingBranch: empty run id (would yield a bare 'staging-' branch)");
  }
  return `${RUN_STAGING_PREFIX}-${runId}`;
}
function resolveStagingBranch(runId, pinned) {
  if (pinned !== void 0 && pinned.length > 0) {
    return pinned;
  }
  return runStagingBranch(runId);
}

// src/cli/current.ts
async function readCurrentForCwd(state, overrides = {}) {
  const cwd = overrides.cwd ?? process.cwd();
  const gitClient = overrides.gitClient ?? new DefaultGitClient();
  let repo;
  try {
    repo = await resolveRepo({ cwd, gitClient });
  } catch {
    return state.readCurrent();
  }
  return state.readCurrentForRepo(repo);
}

// src/cli/subcommands/state.ts
var HELP2 = `factory state \u2014 read run state (read-only)

Usage:
  factory state                 Print the current run's state as JSON
  factory state <run-id>        Print a specific run's state as JSON
  factory state --summary       Print a compact human summary instead

Exit OK with {"current": null} when there is no current run.`;
function summarize(run9) {
  const lines = [
    `run ${run9.run_id}  status=${run9.status}  driver=${run9.driver}`,
    `spec ${run9.spec.repo}#${run9.spec.issue_number} (${run9.spec.spec_id})`,
    `tasks (${Object.keys(run9.tasks).length}):`
  ];
  for (const t of Object.values(run9.tasks)) {
    const bits = [`  ${t.task_id}`, t.status];
    if (t.escalation_rung > 0) bits.push(`rung=${t.escalation_rung}`);
    if (t.pr_number !== void 0) bits.push(`pr=#${t.pr_number}`);
    if (t.failure_class !== void 0) bits.push(`class=${t.failure_class}`);
    lines.push(bits.join("  "));
  }
  return lines.join("\n");
}
async function runState(argv, overrides = {}) {
  const args = parseArgs(argv, { booleans: ["summary"] });
  if (args.flag("help") === true) {
    emitLine(HELP2);
    return EXIT.OK;
  }
  const state = new StateManager();
  const runId = args.positionals[0];
  const runState2 = runId !== void 0 ? await state.read(runId) : await readCurrentForCwd(state, overrides);
  if (runState2 === null) {
    if (args.flag("summary") === true) {
      emitLine("no current run");
    } else {
      emitJson({ current: null });
    }
    return EXIT.OK;
  }
  if (args.flag("summary") === true) {
    emitLine(summarize(runState2));
  } else {
    emitJson(runState2);
  }
  return EXIT.OK;
}
var stateCommand = {
  describe: "Print run state (current or by run-id); read-only",
  run: async (argv) => {
    try {
      return await runState(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`state: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

// src/cli/subcommands/scaffold.ts
import { copyFile, mkdir as mkdir7, readFile as readFile4, writeFile } from "node:fs/promises";
import { existsSync as existsSync6 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname5, join as join7, relative } from "node:path";
import { fileURLToPath } from "node:url";

// src/cli/subcommands/target-settings.ts
import { mkdir as mkdir6, readFile as readFile3 } from "node:fs/promises";
import { existsSync as existsSync5 } from "node:fs";
import { join as join6 } from "node:path";
var log14 = createLogger("cli:target-settings");
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
var DATA_DIR_VERBS = ["Read", "Write", "Edit"];
var STALE_DATA_DIR_ALLOW = [
  "Read(${CLAUDE_PLUGIN_DATA}/**)",
  "Write(${CLAUDE_PLUGIN_DATA}/**)",
  "Edit(${CLAUDE_PLUGIN_DATA}/**)"
];
var STALE_DATA_DIR_ADDITIONAL = "${CLAUDE_PLUGIN_DATA}";
function buildTargetDataDirRules(opts) {
  const baked = tildeShorten(opts.dataDir, opts.home);
  return { allowGlobBase: baked, additionalDir: baked };
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
  const strippedAllow = currentAllow.filter((e) => !STALE_DATA_DIR_ALLOW.includes(e));
  const removedStaleAllow = strippedAllow.length !== currentAllow.length;
  const targetAllow = [
    ...FACTORY_TARGET_BASE_ALLOWLIST,
    ...dataDirAllowRules(dataDirRules.allowGlobBase)
  ];
  const have = new Set(strippedAllow);
  const additions = targetAllow.filter((e) => !have.has(e));
  if (removedStaleAllow || additions.length > 0) {
    permissions.allow = [...strippedAllow, ...additions];
    settings.permissions = permissions;
    changed = true;
  }
  const currentDirs = Array.isArray(permissions.additionalDirectories) ? permissions.additionalDirectories.filter((e) => typeof e === "string") : [];
  const strippedDirs = currentDirs.filter((e) => e !== STALE_DATA_DIR_ADDITIONAL);
  const removedStaleDir = strippedDirs.length !== currentDirs.length;
  const haveDirs = new Set(strippedDirs);
  const dirAdditions = [dataDirRules.additionalDir].filter((e) => !haveDirs.has(e));
  if (removedStaleDir || dirAdditions.length > 0) {
    permissions.additionalDirectories = [...strippedDirs, ...dirAdditions];
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
async function ensureTargetSettings(opts) {
  const dir = join6(opts.targetRoot, ".claude");
  const path3 = join6(dir, "settings.json");
  const created = !existsSync5(path3);
  let existing = {};
  if (!created) {
    const raw = await readFile3(path3, "utf8");
    const parsed = raw.trim().length > 0 ? JSON.parse(raw) : {};
    if (isObject(parsed)) {
      existing = parsed;
    } else {
      log14.warn(
        `${path3} is valid JSON but not an object (${Array.isArray(parsed) ? "array" : typeof parsed}); replacing it with the factory settings object`
      );
    }
  }
  const { settings, changed } = mergeTargetSettings(existing, opts.dataDirRules);
  if (created || changed) {
    await mkdir6(dir, { recursive: true });
    await atomicWriteFile(path3, stringifyJson(settings));
  }
  return { settings, changed, created, path: path3 };
}

// src/cli/subcommands/scaffold.ts
var log15 = createLogger("scaffold");
var HELP3 = `factory scaffold \u2014 prepare a repo for the factory pipeline

Usage:
  factory scaffold [--repo <owner/name>] [--provision]

Copies the committed CI + gate-config templates and probes branch protection on
develop (the integration base). Without --provision a repo whose develop branch is
not protected (strict up-to-date + required checks) causes scaffold to REFUSE loudly.
Per-run staging branches are minted at run create \u2014 scaffold no longer touches them.

Options:
  --repo <owner/name>   OPTIONAL. Target GitHub repo (used for the protection probe).
                        Auto-derived from the 'origin' remote when omitted; an
                        explicit value disagreeing with the remote fails loud.
  --provision           Write branch protection if missing (default: refuse)`;
var GITIGNORE_ENTRIES = ["# factory plugin state", ".claude-plugin-data/", "*.worktree"];
function resolveTemplatesDir() {
  let dir = dirname5(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join7(dir, "templates");
    if (existsSync6(join7(candidate, ".github", "workflows", "quality-gate.yml"))) {
      return candidate;
    }
    const parent = dirname5(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("scaffold: could not locate the plugin templates/ directory");
}
var TEMPLATE_MANIFEST = [
  { rel: ".github/workflows/quality-gate.yml", policy: "managed" },
  { rel: ".github/scripts/shard-mutation-scope.mjs", policy: "managed" },
  { rel: ".stryker.config.json", policy: "seed", nodeOnly: true },
  { rel: ".dependency-cruiser.cjs", policy: "seed", nodeOnly: true },
  { rel: "eslint.config.mjs", policy: "seed", nodeOnly: true }
];
async function applyTemplate(entry, templatesDir, targetRoot, lists) {
  const segs = entry.rel.split("/");
  const src = join7(templatesDir, ...segs);
  const dest = join7(targetRoot, ...segs);
  if (!existsSync6(src)) {
    log15.warn(`template missing, skipping: ${src}`);
    return;
  }
  if (!existsSync6(dest)) {
    await mkdir7(dirname5(dest), { recursive: true });
    await copyFile(src, dest);
    lists.created.push(entry.rel);
    return;
  }
  const [srcText, destText] = await Promise.all([readFile4(src, "utf8"), readFile4(dest, "utf8")]);
  if (srcText === destText) {
    lists.present.push(entry.rel);
    return;
  }
  if (entry.policy === "managed") {
    await copyFile(src, dest);
    lists.updated.push(entry.rel);
  } else {
    lists.outdated.push(entry.rel);
  }
}
async function ensureGitignore(root, lists) {
  const path3 = join7(root, ".gitignore");
  const rel = relative(root, path3);
  if (!existsSync6(path3)) {
    await writeFile(path3, GITIGNORE_ENTRIES.join("\n") + "\n", "utf8");
    lists.created.push(rel);
    return;
  }
  const current = await readFile4(path3, "utf8");
  const missing = GITIGNORE_ENTRIES.filter((e) => !current.split("\n").includes(e));
  if (missing.length === 0) {
    lists.present.push(rel);
    return;
  }
  const sep2 = current.endsWith("\n") ? "" : "\n";
  await writeFile(path3, current + sep2 + missing.join("\n") + "\n", "utf8");
  lists.present.push(rel);
}
async function runScaffold(opts) {
  const lists = { created: [], present: [], updated: [], outdated: [] };
  const isNodePackage = existsSync6(join7(opts.targetRoot, "package.json"));
  for (const entry of TEMPLATE_MANIFEST) {
    if (entry.nodeOnly && !isNodePackage) continue;
    await applyTemplate(entry, opts.templatesDir, opts.targetRoot, lists);
  }
  if (lists.updated.length > 0) {
    log15.info(
      `auto-updated ${lists.updated.length} plugin-managed file(s): ${lists.updated.join(", ")}`
    );
  }
  await ensureGitignore(opts.targetRoot, lists);
  const settings = await ensureTargetSettings({
    targetRoot: opts.targetRoot,
    dataDirRules: opts.dataDirRules
  });
  const settingsRel = relative(opts.targetRoot, settings.path);
  if (settings.created) lists.created.push(settingsRel);
  else lists.present.push(settingsRel);
  const branch = opts.config.git.baseBranch;
  const required = opts.config.git.requiredStatusChecks;
  let state = await probeProtection({
    ghClient: opts.ghClient,
    owner: opts.owner,
    repo: opts.repo,
    branch
  });
  let provisioned = false;
  if (opts.provision) {
    state = await provisionProtection({
      ghClient: opts.ghClient,
      owner: opts.owner,
      repo: opts.repo,
      branch,
      requiredChecks: required,
      provision: true
    });
    provisioned = true;
  }
  requireProtectionOrRefuse(state, required, branch);
  return {
    repo: `${opts.owner}/${opts.repo}`,
    files_created: lists.created,
    files_present: lists.present,
    files_updated: lists.updated,
    files_outdated: lists.outdated,
    protection: {
      enabled: state.enabled,
      strict_up_to_date: state.strictUpToDate,
      required_status_checks: state.requiredStatusChecks,
      provisioned
    },
    settings: { created: settings.created, changed: settings.changed }
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
  const args = parseArgs(argv, { booleans: ["provision"] });
  if (args.flag("help") === true) {
    emitLine(HELP3);
    return EXIT.OK;
  }
  const { owner, repo } = await resolveScaffoldRepo(args);
  const report = await runScaffold({
    targetRoot: process.cwd(),
    templatesDir: resolveTemplatesDir(),
    owner,
    repo,
    config: loadConfig(),
    ghClient: new DefaultGhClient(),
    // Resolve the CANONICAL data dir at the command boundary (corrects the
    // foreign-plugin env-var leak) and bake it into the target permission rules.
    // resolveDataDir() throwing on an unresolvable dir is the correct loud
    // failure — there is deliberately no placeholder fallback.
    dataDirRules: buildTargetDataDirRules({ dataDir: resolveDataDir(), home: homedir2() }),
    provision: args.flag("provision") === true
  });
  emitJson(report);
  return EXIT.OK;
}
var scaffoldCommand = {
  describe: "Prepare a repo (templates + develop branch protection) for the pipeline",
  run: async (argv) => {
    try {
      return await run2(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`scaffold: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

// src/core/stage-machine/stages.ts
var TaskStageEnum = external_exports.enum(["preflight", "tests", "exec", "verify", "ship"]);
var RunStageEnum = external_exports.enum(["finalize"]);
var TASK_STAGE_ORDER = [
  "preflight",
  "tests",
  "exec",
  "verify",
  "ship"
];
function nextStage(s) {
  const i = TASK_STAGE_ORDER.indexOf(s);
  if (i < 0) {
    throw new Error(`nextStage: '${s}' is not a known task stage`);
  }
  const next = TASK_STAGE_ORDER[i + 1];
  return next ?? null;
}
function stageToInFlightStatus(s) {
  switch (s) {
    case "preflight":
      return TaskStatusEnum.enum.pending;
    case "tests":
      return TaskStatusEnum.enum.executing;
    case "exec":
      return TaskStatusEnum.enum.executing;
    case "verify":
      return TaskStatusEnum.enum.reviewing;
    case "ship":
      return TaskStatusEnum.enum.shipping;
  }
}

// src/core/stage-machine/manifest.ts
var SpawnRoleEnum = external_exports.enum([
  "test-writer",
  "executor",
  "implementation-reviewer",
  "quality-reviewer",
  "architecture-reviewer",
  "security-reviewer",
  "silent-failure-hunter",
  "type-design-reviewer",
  "scribe"
]);
var SpawnAgentSchema = external_exports.object({
  /** The reviewer/producer role (closed set). */
  role: SpawnRoleEnum,
  /** Worktree isolation. Defaults to "worktree". */
  isolation: external_exports.enum(["worktree", "none"]).default("worktree"),
  /** Model identifier to run the agent on (non-empty; WS8 resolves the value). */
  model: external_exports.string().min(1),
  /** Hard turn budget for the agent (positive integer). */
  max_turns: external_exports.number().int().positive(),
  /** Pointer to the prompt artifact, run-store relative (non-empty). */
  prompt_ref: external_exports.string().min(1)
});
var SpawnManifestSchema = external_exports.object({
  /** Engine resumes here after the agents return. A per-task stage. */
  stage_after: TaskStageEnum,
  /** Agents to spawn; at least one (an empty manifest is a programming error). */
  agents: external_exports.array(SpawnAgentSchema).min(1)
});
function parseSpawnManifest(raw) {
  return SpawnManifestSchema.parse(raw);
}

// src/core/stage-machine/result.ts
function assertNever(x) {
  throw new Error(
    `assertNever: unhandled value ${JSON.stringify(x)} \u2014 a StageResult.kind was not handled`
  );
}
function advance(to) {
  return { kind: "advance", to };
}
function spawn2(manifest) {
  return { kind: "spawn-agents", manifest };
}
function waitRetry(stage, reason, attempt, max_attempts) {
  return { kind: "wait-retry", stage, reason, attempt, max_attempts };
}
function taskDone() {
  return { kind: "task-terminal", outcome: { outcome: "done" } };
}
function finalizeTerminal(run_status) {
  return { kind: "finalize-terminal", run_status };
}

// src/core/stage-machine/engine.ts
async function runStage(stage, ctx, handlers) {
  const result = await dispatch(stage, ctx, handlers);
  return checkResult(stage, result);
}
async function dispatch(stage, ctx, handlers) {
  const runParsed = RunStageEnum.safeParse(stage);
  if (runParsed.success) {
    const runStageName = runParsed.data;
    switch (runStageName) {
      case "finalize":
        return handlers.finalize(ctx);
      default:
        return assertNever(runStageName);
    }
  }
  const parsed = TaskStageEnum.safeParse(stage);
  if (!parsed.success) {
    throw new Error(`runStage: unknown stage '${String(stage)}'`);
  }
  const taskStage = parsed.data;
  switch (taskStage) {
    case "preflight":
      return handlers.preflight(ctx);
    case "tests":
      return handlers.tests(ctx);
    case "exec":
      return handlers.exec(ctx);
    case "verify":
      return handlers.verify(ctx);
    case "ship":
      return handlers.ship(ctx);
    default:
      return assertNever(taskStage);
  }
}
function checkResult(stage, result) {
  if (RunStageEnum.safeParse(stage).success) {
    if (result.kind !== "finalize-terminal") {
      throw new Error(
        `runStage: run-level stage '${String(stage)}' returned '${result.kind}' \u2014 finalize is terminal and must return only 'finalize-terminal' (it must never spin)`
      );
    }
    return result;
  }
  switch (result.kind) {
    case "advance":
    case "spawn-agents":
    case "graceful-stop":
    case "task-terminal":
      return result;
    case "wait-retry": {
      if (result.attempt > result.max_attempts) {
        throw new Error(
          `runStage: wait-retry for stage '${result.stage}' exceeded max_attempts (${result.attempt} > ${result.max_attempts}); caller must classify a drop (reason: ${result.reason})`
        );
      }
      return result;
    }
    case "finalize-terminal":
      throw new Error(
        `runStage: per-task stage '${String(stage)}' returned 'finalize-terminal' \u2014 that result is reserved for the run-level finalize stage`
      );
    default:
      return assertNever(result);
  }
}
function decideFinalize(run9) {
  const tasks = Object.values(run9.tasks);
  const nonTerminal = tasks.filter((t) => !isTerminalTaskStatus(t.status));
  if (nonTerminal.length > 0) {
    const ids = nonTerminal.map((t) => `${t.task_id}=${t.status}`).join(", ");
    throw new Error(
      `decideFinalize: ${nonTerminal.length} non-terminal task(s) remain [${ids}] \u2014 finalize is terminal and must not be called with in-flight work (would spin in bash)`
    );
  }
  const allDone = tasks.length > 0 && tasks.every((t) => t.status === "done");
  return finalizeTerminal(allDone ? "completed" : "failed");
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
   * The files this task touches — 1..3 (the ≤3-files granularity invariant the
   * spec reviewer also enforces). Empty or >3 is a loud parse error.
   */
  files: external_exports.array(external_exports.string().min(1)).min(1).max(3),
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

// src/spec/gh.ts
var log16 = createLogger("spec:gh");
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
    if (opts.repo) {
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
          `issue #${issueNumber} not found${opts.repo ? ` in ${opts.repo}` : ""}: ${stderr}`
        );
      }
      throw new Error(
        `gh issue view #${issueNumber} failed (code=${result.code ?? "null"}): ${stderr}`
      );
    }
    if (result.truncated) {
      throw new Error(
        `gh issue view #${issueNumber} output was truncated; cannot parse a clipped payload`
      );
    }
    const parsed = parseJson(result.stdout, `gh issue #${issueNumber}`);
    const title = typeof parsed.title === "string" ? parsed.title : "";
    if (title.length === 0) {
      throw new Error(`gh issue view #${issueNumber}: missing or empty title in response`);
    }
    const rawBody = typeof parsed.body === "string" ? parsed.body : "";
    const { body, body_truncated } = this.capBody(rawBody);
    if (body_truncated) {
      log16.warn(`PRD body for issue #${issueNumber} exceeded ${this.bodyMaxBytes} bytes; truncated`);
    }
    const labels = Array.isArray(parsed.labels) ? parsed.labels.map(
      (l) => l && typeof l === "object" && "name" in l && typeof l.name === "string" ? l.name : typeof l === "string" ? l : null
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
import { readFile as readFile5, readdir as readdir2 } from "node:fs/promises";
import { join as join8 } from "node:path";
var log17 = createLogger("spec:store");
var SPEC_MD_FILE = "spec.md";
var TASKS_FILE = "tasks.json";
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
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
var SpecStore = class {
  dataDir;
  docsRoot;
  constructor(opts = {}) {
    this.dataDir = resolveDataDir(opts);
    this.docsRoot = opts.docsRoot ?? join8(process.cwd(), "docs");
  }
  /**
   * Resolve an existing spec for `(repo, issueNumber)` — Δ X reuse. Scans the
   * repo's spec dir for a `spec_id` starting with `<issue>-` and returns its
   * parsed manifest, else null. The issue number (not the slug) is the lookup
   * key, so a rerun reuses the spec even if the slug would differ on regen.
   *
   * @throws if a matching dir exists but its manifest/tasks are unreadable or
   *         invalid (a corrupt durable spec is loud, never silently a miss).
   */
  async resolveByIssue(repo, issueNumber) {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(
        `resolveByIssue: issue number must be a positive integer, got ${issueNumber}`
      );
    }
    const repoRoot = join8(specsRoot(this.dataDir), repoKey(repo));
    let entries;
    try {
      entries = await readdir2(repoRoot);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    const prefix = `${issueNumber}-`;
    const matches = entries.filter((e) => issueOf(e) === issueNumber && e.startsWith(prefix));
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(
        `resolveByIssue: multiple specs for issue #${issueNumber} in ${repo}: ${matches.join(", ")}`
      );
    }
    const specId = matches[0];
    return this.read(repo, specId);
  }
  /** Read + validate the manifest for a known `(repo, spec_id)`. */
  async read(repo, specId) {
    const dir = specDir(this.dataDir, repo, specId);
    const tasksRaw = await readFile5(join8(dir, TASKS_FILE), "utf8");
    const tasks = parseSpecTasks(parseJson(tasksRaw, join8(dir, TASKS_FILE)));
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
   * Durably write a spec: `spec.md` + the bare `tasks.json` array. The manifest
   * header is persisted as a sidecar so {@link read} can reconstruct
   * `generated_at` without re-running the generator.
   *
   * F-specloc — also mirrors `spec.md` + the bare `tasks.json` into the in-repo
   * reviewable copy (`<docsRoot>/factory/<spec-id>/`). The mirror is a strict
   * subset (no `spec.meta.json` sidecar): the sidecar is a dataDir reconstruction
   * detail, and the canonical read-path never consults the mirror. Reruns still
   * resolve by issue number against the dataDir store (unchanged).
   */
  async write(manifest, specMd) {
    const parsed = parseSpecManifest(manifest);
    const dir = specDir(this.dataDir, parsed.repo, parsed.spec_id);
    const tasksJson = stringifyJson(parsed.tasks);
    await atomicWriteFile(join8(dir, SPEC_MD_FILE), specMd);
    await atomicWriteFile(join8(dir, TASKS_FILE), tasksJson);
    await atomicWriteFile(
      join8(dir, META_FILE),
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
      await atomicWriteFile(join8(reviewDir, SPEC_MD_FILE), specMd);
      await atomicWriteFile(join8(reviewDir, TASKS_FILE), tasksJson);
    } catch (err) {
      mirrored = false;
      log17.warn(
        `could not write reviewable copy to ${reviewDir} (${err instanceof Error ? err.message : String(err)}) \u2014 the canonical spec at ${dir} is unaffected; run continues`
      );
    }
    log17.info(
      `wrote spec ${parsed.spec_id} (${parsed.tasks.length} tasks) to ${dir} ` + (mirrored ? `(reviewable copy: ${reviewDir})` : `(reviewable copy SKIPPED \u2014 see warning)`)
    );
    return this.toPointer(parsed);
  }
  /** Build the run-facing {@link SpecPointer} from a manifest. */
  toPointer(manifest) {
    return {
      repo: manifest.repo,
      spec_id: manifest.spec_id,
      issue_number: manifest.issue_number
    };
  }
  async readMeta(dir) {
    const raw = await readFile5(join8(dir, META_FILE), "utf8");
    const meta = parseJson(
      raw,
      join8(dir, META_FILE)
    );
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
    model: SPEC_DEFAULTS.specModel,
    effort: SPEC_DEFAULTS.specEffort,
    context: {
      issue_number: prd.issue_number,
      title: prd.title,
      body: prd.body,
      labels: prd.labels
    }
  };
}
function buildReviewSpawn(prd, generated) {
  return {
    role: "spec-reviewer",
    model: SPEC_DEFAULTS.specModel,
    effort: SPEC_DEFAULTS.specEffort,
    context: {
      issue_number: prd.issue_number,
      prd_body: prd.body,
      spec_md: generated.specMd,
      tasks: generated.tasks
    }
  };
}

// src/spec/gates.ts
function combineGates(...results) {
  const blockers = results.flatMap((r) => r.blockers);
  return { passed: blockers.length === 0, blockers };
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
  if (t.split(/\s+/).length > 4) return false;
  return HORIZONTAL_MARKERS.some((m) => t === m || t.startsWith(m + " ") || t.endsWith(" " + m));
}
function verticalSliceGate(tasks) {
  if (tasks.length <= 1) return { passed: true, blockers: [] };
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
  if (c.length < 8) return true;
  return VAGUE_MARKERS.some((m) => c.includes(m));
}
function hasCoveringTest(criterion, tests) {
  const ck = keywords(criterion);
  if (ck.size === 0) return false;
  return tests.some((t) => {
    const tk = keywords(t);
    for (const w of ck) if (tk.has(w)) return true;
    return false;
  });
}
function testabilityGate(tasks) {
  const blockers = [];
  for (const task of tasks) {
    for (const criterion of task.acceptance_criteria) {
      if (isVague(criterion)) {
        blockers.push(
          `testability: task ${task.task_id} has a vague/non-actionable criterion: "${criterion}"`
        );
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
function extractPrdRequirements(body) {
  const lines = body.split(/\r?\n/);
  const reqs = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet && bullet[1] && bullet[1].trim().length > 0) {
      reqs.push(bullet[1].trim());
      continue;
    }
    if (/\b(must|shall|should|need to|required to)\b/i.test(line) && !line.startsWith("#")) {
      reqs.push(line);
    }
  }
  return reqs;
}
function requirementCovered(requirement, allCriteria) {
  const rk = keywords(requirement);
  if (rk.size === 0) return true;
  return allCriteria.some((c) => {
    const ck = keywords(c);
    let shared = 0;
    for (const w of rk) if (ck.has(w)) shared++;
    return shared >= Math.min(2, rk.size);
  });
}
function taskLaddersToPrd(task, requirements) {
  const text = [task.title, task.description, ...task.acceptance_criteria].join(" ");
  const tk = keywords(text);
  if (requirements.length === 0) return false;
  return requirements.some((r) => {
    const rk = keywords(r);
    for (const w of rk) if (tk.has(w)) return true;
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
      blockers.push(
        `traceability: task ${task.task_id} ("${task.title}") does not ladder to any PRD requirement`
      );
    }
  }
  return { passed: blockers.length === 0, blockers };
}
function runSpecGates(prd, tasks) {
  return combineGates(
    verticalSliceGate(tasks),
    testabilityGate(tasks),
    traceabilityGate(prd, tasks)
  );
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

// src/spec/pipeline.ts
var log18 = createLogger("spec:pipeline");
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

// src/quota/usage-source.ts
import { existsSync as existsSync7, readFileSync as readFileSync3 } from "node:fs";
import { join as join9 } from "node:path";
var log19 = createLogger("quota:usage");
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
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
    log19.warn(`usage-cache.json is ${age}s old (>${STALE_WARN_SECONDS}s) \u2014 data may be stale`);
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
  return join9(dataDir, "usage-cache.json");
}
var StatuslineUsageSignal = class {
  opts;
  constructor(opts = {}) {
    this.opts = opts;
  }
  async read() {
    const now = (this.opts.now ?? nowEpoch)();
    let dataDir;
    try {
      dataDir = resolveDataDir(this.opts);
    } catch {
      return unavailable("usage-cache-missing");
    }
    const file = usageCachePath(dataDir);
    if (!existsSync7(file)) {
      log19.warn(`usage-cache.json not found at ${file}; emitting unavailable sentinel`);
      return unavailable("usage-cache-missing");
    }
    let raw;
    try {
      raw = parseJson(readFileSync3(file, "utf8"), file);
    } catch {
      log19.warn(`usage-cache.json is malformed at ${file}; emitting unavailable sentinel`);
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
  if (value < lo) return lo;
  if (value > hi) return hi;
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
  return curve[idx];
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

// src/quota/checkpoint.ts
function buildCheckpoint(decision) {
  switch (decision.kind) {
    case "pause-5h":
      return {
        status: "paused",
        quota: QuotaCheckpointSchema.parse({
          binding_window: "5h",
          resets_at_epoch: decision.resetsAtEpoch
        })
      };
    case "suspend-7d":
      return {
        status: "suspended",
        quota: QuotaCheckpointSchema.parse({
          binding_window: "7d",
          resets_at_epoch: decision.resetsAtEpoch
        })
      };
  }
}
function clearCheckpoint() {
  return { status: "running", quota: void 0 };
}

// src/quota/router.ts
function selectProducerModel(riskTier, config) {
  const models = config.quota.producerModels;
  switch (riskTier) {
    case "low":
      return models.low;
    case "medium":
      return models.medium;
    case "high":
      return models.high;
    default:
      return assertNever(riskTier);
  }
}

// src/quota/resume.ts
function planResume(run9, reading, config, nowEpoch2) {
  if (run9.status !== "paused" && run9.status !== "suspended") {
    return { kind: "not-resumable", status: run9.status };
  }
  const decision = evaluate(reading, config, nowEpoch2);
  if (decision.kind === "proceed") {
    return { kind: "resume", clear: clearCheckpoint() };
  }
  return { kind: "still-blocked", decision };
}

// src/scoring/partial-report.ts
function buildPartialReport(run9, manifest, opts = {}) {
  const specById = new Map(manifest.tasks.map((t) => [t.task_id, t]));
  const orderOf = new Map(manifest.tasks.map((t, i) => [t.task_id, i]));
  const shipped = [];
  const failures = [];
  const incomplete = [];
  for (const task of Object.values(run9.tasks)) {
    const spec = specById.get(task.task_id);
    if (spec === void 0) {
      throw new Error(
        `buildPartialReport: run task '${task.task_id}' is absent from spec '${manifest.spec_id}' \u2014 run/spec mismatch (wrong spec paired with run ${run9.run_id})`
      );
    }
    if (task.status === "done") {
      shipped.push({
        task_id: task.task_id,
        title: spec.title,
        branch: task.branch,
        pr_number: task.pr_number
      });
    } else if (task.status === "dropped") {
      failures.push({
        task_id: task.task_id,
        title: spec.title,
        failure_class: task.failure_class,
        failure_reason: task.failure_reason,
        unmet_criteria: [...spec.acceptance_criteria],
        branch: task.branch,
        pr_number: task.pr_number
      });
    } else {
      incomplete.push({ task_id: task.task_id, title: spec.title, status: task.status });
    }
  }
  const bySpecOrder = (a, b) => (orderOf.get(a.task_id) ?? 0) - (orderOf.get(b.task_id) ?? 0);
  shipped.sort(bySpecOrder);
  failures.sort(bySpecOrder);
  incomplete.sort(bySpecOrder);
  return {
    run_id: run9.run_id,
    run_status: run9.status,
    spec_id: run9.spec.spec_id,
    issue_number: run9.spec.issue_number,
    repo: run9.spec.repo,
    generated_at: opts.now ?? nowIso(),
    totals: {
      total: shipped.length + failures.length + incomplete.length,
      shipped: shipped.length,
      failed: failures.length,
      incomplete: incomplete.length
    },
    shipped,
    failures,
    incomplete
  };
}
function renderFailureIssue(failure, report) {
  const lines = [
    `Task \`${failure.task_id}\` was dropped during factory run \`${report.run_id}\`.`,
    "",
    `- **Spec:** \`${report.spec_id}\` (PRD #${report.issue_number})`,
    `- **Failure class:** \`${failure.failure_class}\``,
    `- **Reason:** ${failure.failure_reason}`
  ];
  if (failure.branch !== void 0) lines.push(`- **Branch:** \`${failure.branch}\``);
  if (failure.pr_number !== void 0) lines.push(`- **PR:** #${failure.pr_number}`);
  lines.push("", "**Unmet acceptance criteria:**", "");
  for (const c of failure.unmet_criteria) lines.push(`- [ ] ${c}`);
  return {
    title: `[factory] ${failure.task_id} dropped (${failure.failure_class}): ${failure.title}`,
    body: lines.join("\n")
  };
}
function statusLabel(status) {
  return status.toUpperCase();
}
function renderPartialReportMarkdown(report) {
  const out = [];
  out.push(`# Factory run report \u2014 \`${report.run_id}\``);
  out.push("");
  out.push(
    `**Status:** ${statusLabel(report.run_status)} \xB7 **Spec:** \`${report.spec_id}\` (PRD #${report.issue_number}) \xB7 **Repo:** ${report.repo}`
  );
  out.push(`**Generated:** ${report.generated_at}`);
  out.push("");
  out.push(
    `**Tasks:** ${report.totals.total} total \xB7 ${report.totals.shipped} shipped \xB7 ${report.totals.failed} failed \xB7 ${report.totals.incomplete} incomplete`
  );
  out.push("");
  out.push(`## Shipped (${report.shipped.length})`);
  if (report.shipped.length === 0) {
    out.push("_none_");
  } else {
    for (const s of report.shipped) {
      const pr = s.pr_number !== void 0 ? ` \u2014 PR #${s.pr_number}` : "";
      const br = s.branch !== void 0 ? ` (\`${s.branch}\`)` : "";
      out.push(`- \`${s.task_id}\` \u2014 ${s.title}${pr}${br}`);
    }
  }
  out.push("");
  if (report.failures.length > 0) {
    out.push(`## Failed (${report.failures.length})`);
    for (const f of report.failures) {
      out.push("");
      out.push(`### \`${f.task_id}\` \u2014 ${f.title}`);
      out.push(`- **Class:** \`${f.failure_class}\``);
      out.push(`- **Reason:** ${f.failure_reason}`);
      out.push("- **Unmet acceptance criteria:**");
      for (const c of f.unmet_criteria) out.push(`  - ${c}`);
    }
    out.push("");
  }
  if (report.incomplete.length > 0) {
    out.push(`## Incomplete (${report.incomplete.length})`);
    for (const i of report.incomplete) {
      out.push(`- \`${i.task_id}\` \u2014 ${i.title} (\`${i.status}\`)`);
    }
    out.push("");
  }
  return out.join("\n");
}

// src/scoring/summary.ts
function durationSeconds(startedAt, endedAt) {
  if (endedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const delta = Math.floor((end - start) / 1e3);
  return delta >= 0 ? delta : null;
}
function buildRunSummary(run9, report, opts = {}) {
  const failuresByClass = Object.fromEntries(FailureClassEnum.options.map((c) => [c, 0]));
  for (const f of report.failures) {
    failuresByClass[f.failure_class] += 1;
  }
  const tasks = Object.values(run9.tasks);
  const effort = {
    reviewer_results: tasks.reduce((n, t) => n + t.reviewers.length, 0),
    max_escalation_rung: tasks.reduce((m, t) => Math.max(m, t.escalation_rung), 0)
  };
  const shipped_prs = report.shipped.map((s) => ({
    task_id: s.task_id,
    ...s.pr_number !== void 0 ? { pr_number: s.pr_number } : {},
    ...s.branch !== void 0 ? { branch: s.branch } : {}
  }));
  return {
    run_id: run9.run_id,
    run_status: run9.status,
    driver: run9.driver,
    spec_id: run9.spec.spec_id,
    issue_number: run9.spec.issue_number,
    repo: run9.spec.repo,
    generated_at: opts.now ?? nowIso(),
    timing: {
      started_at: run9.started_at,
      ended_at: run9.ended_at,
      duration_seconds: durationSeconds(run9.started_at, run9.ended_at)
    },
    totals: report.totals,
    failures_by_class: failuresByClass,
    effort,
    shipped_prs
  };
}

// src/scoring/dead-surface.ts
function parseTsPruneOutput(stdout) {
  const out = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = /^(.+):(\d+) - (.+)$/.exec(line);
    if (m === null) continue;
    out.push({ file: m[1], line: Number(m[2]), name: m[3] });
  }
  return out;
}
function normalizePath(p) {
  return p.startsWith("./") ? p.slice(2) : p;
}
function scopeToChangedFiles(findings, changedFiles) {
  const changed = new Set(changedFiles.map(normalizePath));
  return findings.filter((f) => changed.has(normalizePath(f.file)));
}
var UNAVAILABLE_MARKERS = [
  "could not determine executable",
  "command not found",
  "not found",
  "no such file"
];
var TsPruneRunner = class {
  tool = "ts-prune";
  /** Timeout for the detector, ms. Report-only — a slow tool must not wedge finalize. */
  timeoutMs;
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 12e4;
  }
  async run({ cwd }) {
    try {
      const r = await exec("npx", ["--no-install", "ts-prune"], { cwd, timeoutMs: this.timeoutMs });
      const stderrLc = r.stderr.toLowerCase();
      const looksMissing = r.stdout.trim().length === 0 && UNAVAILABLE_MARKERS.some((m) => stderrLc.includes(m));
      return {
        available: !looksMissing,
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        truncated: r.truncated
      };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { available: false, code: null, stdout: "", stderr: String(err), truncated: false };
      }
      throw err;
    }
  }
};
async function scanDeadSurface(runner, changedFiles, opts) {
  const base = {
    tool: runner.tool,
    changed_file_count: changedFiles.length,
    total_found: 0,
    findings: []
  };
  let result;
  try {
    result = await runner.run({ cwd: opts.cwd });
  } catch (err) {
    return { ...base, status: "error", note: `${runner.tool} failed: ${err.message}` };
  }
  if (!result.available) {
    return {
      ...base,
      status: "skipped",
      note: `${runner.tool} not available \u2014 install it to enumerate dead surface`
    };
  }
  if (result.truncated) {
    return {
      ...base,
      status: "error",
      note: `${runner.tool} output was truncated \u2014 findings unreliable, not reported`
    };
  }
  if (result.code === null) {
    return { ...base, status: "error", note: `${runner.tool} was killed before completing` };
  }
  const all = parseTsPruneOutput(result.stdout);
  const scoped = scopeToChangedFiles(all, changedFiles);
  return {
    tool: runner.tool,
    status: "ok",
    changed_file_count: changedFiles.length,
    total_found: all.length,
    findings: scoped,
    note: changedFiles.length === 0 ? "run diff is empty \u2014 no files to scope findings to" : `${scoped.length} unreferenced export(s) in the run diff (of ${all.length} project-wide)`
  };
}

// src/scoring/telemetry.ts
var log20 = createLogger("telemetry");
async function emitMetric(dataDir, runId, event, data, opts = {}) {
  const record = {
    ts: opts.now ?? nowIso(),
    run_id: runId,
    event,
    ...data !== void 0 ? { data } : {}
  };
  try {
    await appendJsonl(runMetricsPath(dataDir, runId), record);
  } catch (err) {
    log20.warn(`failed to write metric '${event}' for ${runId}: ${err.message}`);
  }
  return record;
}
async function recordRunFinalized(dataDir, report, opts = {}) {
  const now = opts.now ?? nowIso();
  await emitMetric(
    dataDir,
    report.run_id,
    "run.finalized",
    {
      status: report.run_status,
      spec_id: report.spec_id,
      issue_number: report.issue_number,
      totals: report.totals
    },
    { now }
  );
  for (const f of report.failures) {
    await emitMetric(
      dataDir,
      report.run_id,
      "task.dropped",
      { task_id: f.task_id, failure_class: f.failure_class },
      { now }
    );
  }
}

// src/producer/agents.ts
function parseProducerStatus(raw) {
  const line = raw.trim();
  const upper = line.toUpperCase();
  if (upper.includes("BLOCKED") && upper.includes("ESCALATE")) {
    return { status: "blocked-escalate", reason: line };
  }
  if (upper.includes("NEEDS_CONTEXT") || upper.includes("NEEDS CONTEXT")) {
    return { status: "needs-context", reason: line };
  }
  if (upper.includes("DONE")) {
    return { status: "done" };
  }
  return {
    status: "error",
    reason: line.length > 0 ? `unparseable producer status: ${line}` : "empty producer status"
  };
}

// src/producer/model-dial.ts
var TIER_LADDER = ["low", "medium", "high"];
function escalateTier(tier) {
  const idx = TIER_LADDER.indexOf(tier);
  const next = TIER_LADDER[Math.min(idx + 1, TIER_LADDER.length - 1)];
  return next ?? tier;
}
function dialForRung(riskTier, rung, config) {
  if (rung < 0 || !Number.isInteger(rung)) {
    throw new Error(`dialForRung: rung must be a non-negative integer, got ${rung}`);
  }
  const baseModel = selectProducerModel(riskTier, config);
  if (rung <= 1) {
    return {
      model: baseModel,
      rung,
      injectsPriorFailure: false
    };
  }
  const escalatedTier = escalateTier(riskTier);
  const escalatedModel = selectProducerModel(escalatedTier, config);
  return {
    model: escalatedModel,
    rung,
    injectsPriorFailure: true
  };
}

// src/producer/prompt-context.ts
function toFixInstruction(f) {
  const base = { reviewer: f.reviewer, description: f.description };
  if (f.file !== void 0 && f.line !== void 0) {
    return { ...base, file: f.file, line: f.line };
  }
  if (f.file !== void 0) {
    return { ...base, file: f.file };
  }
  return base;
}
function buildProducerContext(input) {
  const fixInstructions = (input.confirmedBlockers ?? []).map(toFixInstruction);
  const priorFailures = input.priorFailures ?? [];
  return {
    taskId: input.taskId,
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.visibleCriteria,
    files: input.files,
    rung: input.rung,
    fixInstructions,
    priorFailures,
    injectedPriorFailure: priorFailures.length > 0
  };
}

// src/producer/classify.ts
function exhaustive(x) {
  throw new Error(`classify: unhandled FailureSignal ${JSON.stringify(x)}`);
}
function classifyFailure(signal) {
  switch (signal.kind) {
    case "producer-status": {
      if (signal.status === "blocked-escalate") {
        return {
          action: "drop",
          failureClass: "spec-defect",
          reason: `producer reported the task unworkable as specified: ${signal.reason}`
        };
      }
      return { action: "retry", reason: signal.reason };
    }
    case "gate-failure": {
      if (signal.structurallyUnfixable) {
        return {
          action: "drop",
          failureClass: "spec-defect",
          reason: `deterministic gate '${signal.gate}' is structurally unfixable by the producer: ${signal.reason}`
        };
      }
      return { action: "retry", reason: `gate '${signal.gate}' failed: ${signal.reason}` };
    }
    case "environmental": {
      return {
        action: "drop",
        failureClass: "blocked-environmental",
        reason: `environmental blocker: ${signal.reason}`
      };
    }
    case "verifier-error": {
      return { action: "retry", reason: `verifier error (unresolved): ${signal.reason}` };
    }
    case "floor-blocked": {
      return { action: "retry", reason: signal.reason };
    }
    default:
      return exhaustive(signal);
  }
}

// src/verifier/judgment/config.ts
var FALLBACK_REVIEW_MODEL = "opus";
function resolveReviewModel(config) {
  const m = config.review.model;
  if (m !== void 0 && m.trim().length === 0) {
    throw new Error(
      "review.model is configured but empty \u2014 set a non-empty fixed reviewer model or unset it"
    );
  }
  return m ?? FALLBACK_REVIEW_MODEL;
}

// src/verifier/judgment/panel.ts
var PANEL_ROLES = [
  "implementation-reviewer",
  "quality-reviewer",
  "architecture-reviewer",
  "security-reviewer",
  "silent-failure-hunter",
  "type-design-reviewer"
];
function promptRefFor(role) {
  return `reviews/prompts/${role}.md`;
}
function buildPanelManifest(stageAfter, model, maxTurns) {
  const agents = PANEL_ROLES.map((role) => ({
    role,
    isolation: "worktree",
    model,
    max_turns: maxTurns,
    prompt_ref: promptRefFor(role)
  }));
  return parseSpawnManifest({ stage_after: stageAfter, agents });
}

// src/verifier/judgment/finding.ts
var log21 = createLogger("finding");
var FindingSeverityEnum = external_exports.enum(["info", "warning", "error", "critical"]);
var FindingSchema = external_exports.object({
  /** Which panel reviewer raised this (free-form; the role string). */
  reviewer: external_exports.string().min(1),
  /** Closed severity. */
  severity: FindingSeverityEnum,
  /** True iff this finding, if upheld, BLOCKS the floor. */
  blocking: external_exports.boolean(),
  /** Cited file path (run-tree relative). Absent ⇒ uncitable. */
  file: external_exports.string().min(1).optional(),
  /** Cited 1-based line number. Absent ⇒ uncitable. Must be positive. */
  line: external_exports.number().int().positive().optional(),
  /**
   * The VERBATIM code the reviewer claims to be quoting. Required and non-empty —
   * a finding with no quote cannot be citation-verified, so we reject it loudly
   * rather than admit an unverifiable claim. (An empty string is rejected by
   * `.min(1)`.)
   */
  quote: external_exports.string().min(1),
  /** Human-facing description of the concern. */
  description: external_exports.string().min(1)
});
var RawReviewVerdictEnum = external_exports.enum(["approve", "blocked", "error"]);
var RawReviewSchema = external_exports.object({
  /** The reviewer identity (role string). */
  reviewer: external_exports.string().min(1),
  /** The reviewer's self-reported verdict. */
  verdict: RawReviewVerdictEnum,
  /** Findings raised. May be empty (an `approve` with no findings). */
  findings: external_exports.array(FindingSchema)
});
var KNOWN_REVIEW_KEYS = new Set(Object.keys(RawReviewSchema.shape));
var KNOWN_FINDING_KEYS = new Set(Object.keys(FindingSchema.shape));
function warnStrippedKeys(context, topObj, topKnown, findingsArr, findingKnown) {
  const topUnknown = [];
  const findingUnknown = [];
  if (topObj !== null && typeof topObj === "object" && !Array.isArray(topObj)) {
    for (const k of Object.keys(topObj)) {
      if (!topKnown.has(k)) topUnknown.push(k);
    }
  }
  if (Array.isArray(findingsArr)) {
    for (const f of findingsArr) {
      if (f !== null && typeof f === "object" && !Array.isArray(f)) {
        for (const k of Object.keys(f)) {
          if (!findingKnown.has(k) && !findingUnknown.includes(k)) findingUnknown.push(k);
        }
      }
    }
  }
  if (topUnknown.length > 0 || findingUnknown.length > 0) {
    log21.warn(
      `review parse: stripped unknown keys from reviewer '${context}' payload: top[${topUnknown.join(", ")}] findings[${findingUnknown.join(", ")}]`
    );
  }
}
function parseRawReview(raw) {
  const result = RawReviewSchema.parse(raw);
  const reviewerLabel = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? String(raw.reviewer ?? result.reviewer) : result.reviewer;
  const rawFindings = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw.findings : void 0;
  warnStrippedKeys(reviewerLabel, raw, KNOWN_REVIEW_KEYS, rawFindings, KNOWN_FINDING_KEYS);
  return result;
}
function isCitable(f) {
  return f.file !== void 0 && f.line !== void 0;
}

// src/verifier/judgment/citation-verify.ts
var CITATION_WINDOW = 2;
function redactFinding(f) {
  return { ...f, quote: redactSecrets(f.quote), description: redactSecrets(f.description) };
}
function checkQuote(quote, line, lines) {
  const lo = Math.max(1, line - CITATION_WINDOW);
  const hi = Math.min(lines.length, line + CITATION_WINDOW);
  if (lo > hi) {
    return "line-out-of-range";
  }
  for (let n = lo; n <= hi; n++) {
    const text = lines[n - 1];
    if (text !== void 0 && text.includes(quote)) return null;
  }
  return "quote-not-in-window";
}
function verifyCitations(findings, source, options = {}) {
  const redact = options.redact ?? true;
  const kept = [];
  const dropped = [];
  const audit = [];
  for (const f of findings) {
    if (!isCitable(f)) {
      dropped.push({ finding: f, reason: "uncitable" });
      audit.push(`DROP uncitable: ${f.reviewer} \u2014 ${f.description}`);
      continue;
    }
    const lines = source.readLines(f.file);
    if (lines === null) {
      dropped.push({ finding: f, reason: "file-not-found" });
      audit.push(`DROP file-not-found ${f.file}:${f.line}: ${f.reviewer}`);
      continue;
    }
    const reason = checkQuote(f.quote, f.line, lines);
    if (reason !== null) {
      dropped.push({ finding: f, reason });
      audit.push(`DROP ${reason} ${f.file}:${f.line}: ${f.reviewer}`);
      continue;
    }
    const retained = redact ? redactFinding(f) : f;
    kept.push(retained);
    audit.push(`KEEP ${f.file}:${f.line}: ${f.reviewer}`);
  }
  return { kept, dropped, audit };
}

// src/verifier/judgment/finding-verifier.ts
async function confirmBlocker(finding, runner, finderIdentity) {
  if (runner.identity === finderIdentity) {
    throw new Error(
      `finding-verifier identity '${runner.identity}' equals the finder's \u2014 the verifier must be INDEPENDENT (D27)`
    );
  }
  let verdict;
  try {
    verdict = await runner.confirm(finding);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "error", reason: `finding-verifier errored: ${detail}` };
  }
  return verdict.holds ? { status: "confirmed", evidence: { note: verdict.note } } : { status: "refuted", reason: verdict.note };
}

// src/verifier/judgment/panel-run.ts
async function adjudicateReviewer(review, source, makeRunner2, redact) {
  const blocking = review.findings.filter((f) => f.blocking);
  const { kept } = verifyCitations(blocking, source, { redact });
  const runner = makeRunner2(review);
  const confirmed = [];
  let hadVerifierError = false;
  for (const finding of kept) {
    if (!isCitable(finding)) continue;
    const outcome = await confirmBlocker(finding, runner, review.reviewer);
    if (outcome.status === "confirmed") {
      confirmed.push(finding);
    } else if (outcome.status === "error") {
      hadVerifierError = true;
    }
  }
  return {
    reviewer: review.reviewer,
    rawVerdict: review.verdict,
    confirmedBlockers: confirmed,
    hadVerifierError
  };
}
function reviewerResultOf(a) {
  if (a.hadVerifierError || a.rawVerdict === "error") {
    return {
      reviewer: a.reviewer,
      verdict: "error",
      confirmed_blockers: a.confirmedBlockers.length
    };
  }
  if (a.confirmedBlockers.length > 0) {
    return {
      reviewer: a.reviewer,
      verdict: "blocked",
      confirmed_blockers: a.confirmedBlockers.length
    };
  }
  return { reviewer: a.reviewer, verdict: "approve", confirmed_blockers: 0 };
}
async function runPanel(input) {
  const redact = input.redact ?? true;
  const adjudicated = [];
  for (const review of input.reviews) {
    adjudicated.push(await adjudicateReviewer(review, input.source, input.makeRunner, redact));
  }
  const reviewerResults = adjudicated.map(reviewerResultOf);
  const floor = deriveFloorVerdict({ reviewers: reviewerResults }, input.gateEvidence);
  const result = floor.passed ? advance(nextOrSelf(input.stage)) : waitRetry(
    input.stage,
    floorBlockReason(reviewerResults, input.gateEvidence),
    input.attempt ?? 1,
    input.maxAttempts ?? 1
  );
  const crossVendorAbsence = input.crossVendor?.status === "absent" ? { reason: input.crossVendor.reason } : void 0;
  return crossVendorAbsence === void 0 ? { adjudicated, reviewerResults, floor, result } : { adjudicated, reviewerResults, floor, result, crossVendorAbsence };
}
function nextOrSelf(stage) {
  return stage === "verify" ? "ship" : stage;
}

// src/producer/ladder.ts
var ESCALATION_CAP = 2;

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

// src/verifier/deterministic/strategy.ts
function ran(gate, observed, detail) {
  const evidence = detail === void 0 ? { gate, observed } : { gate, observed, detail };
  return { kind: "ran", evidence };
}
function skip(gate, reason) {
  return { kind: "skip", gate, reason };
}

// src/verifier/deterministic/memo.ts
var GateMemo = class {
  /** `${gate}@${treeSha}` → evidence (ground truth, never a verdict). */
  evidence = /* @__PURE__ */ new Map();
  /** `${taskId}@${tipSha}` → the TDD verdict struct (re-derived by the runner). */
  tdd = /* @__PURE__ */ new Map();
  evKey(gate, treeSha) {
    return `${gate}@${treeSha}`;
  }
  tddKey(taskId, tipSha) {
    return `${taskId}@${tipSha}`;
  }
  /** Look up cached evidence for a gate at a tree sha (undefined = miss). */
  getEvidence(gate, treeSha) {
    return this.evidence.get(this.evKey(gate, treeSha));
  }
  /** Cache a gate's evidence at a tree sha. */
  putEvidence(gate, treeSha, ev) {
    this.evidence.set(this.evKey(gate, treeSha), ev);
  }
  /** Look up the memoized TDD verdict for a task at a tip sha (undefined = miss). */
  getTdd(taskId, tipSha) {
    return this.tdd.get(this.tddKey(taskId, tipSha));
  }
  /** Memoize the TDD verdict for a task at a tip sha. */
  putTdd(taskId, tipSha, verdict) {
    this.tdd.set(this.tddKey(taskId, tipSha), verdict);
  }
};

// src/verifier/deterministic/scope.ts
function isTestPath(file) {
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs)$/.test(file)) return true;
  if (/_test\.(go|py|rb|exs)$/.test(file)) return true;
  if (/Test\.(java|kt|php)$/.test(file)) return true;
  if (/Tests\.(swift|cs)$/.test(file)) return true;
  if (/_spec\.rb$/.test(file)) return true;
  if (/^(tests|test|spec|__tests__)\//.test(file)) return true;
  if (/\/(tests|test|spec|__tests__)\//.test(file)) return true;
  return false;
}
function isDocsPath(file) {
  if (/^docs\//.test(file)) return true;
  if (file.endsWith(".md")) return true;
  return false;
}
function isMutableSrc(file) {
  if (!/^src\/.*\.ts$/.test(file)) return false;
  if (/\.(test|spec|d)\.ts$/.test(file)) return false;
  if (file.includes("/types/")) return false;
  if (file.includes("/data/")) return false;
  if (/(^|\/)index\.ts$/.test(file)) return false;
  return true;
}
function mutationScope(changedFiles) {
  return filterDedup(changedFiles, isMutableSrc);
}
function diffScopedTestFiles(changedFiles) {
  return filterDedup(changedFiles, isTestPath);
}
function filterDedup(files, keep) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const f of files) {
    if (!keep(f)) continue;
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

// src/verifier/deterministic/strategies/test.ts
var testStrategy = {
  id: "test",
  async run(ctx) {
    const base = `origin/${ctx.baseRef}`;
    const changed = await ctx.tools.git.changedFiles(base, { cwd: ctx.worktree });
    const scoped = diffScopedTestFiles(changed);
    const result = await ctx.tools.vitest.run(scoped, { cwd: ctx.worktree });
    if (result.truncated) {
      throw new Error("test gate: vitest output truncated \u2014 refusing to judge a clipped run");
    }
    const observed = result.code === 0;
    const detail = scoped.length > 0 ? `diff-scoped (${scoped.length} test file(s))` : "un-scoped";
    return ran("test", observed, `vitest exit=${result.code ?? "null"} ${detail}`);
  }
};

// src/verifier/deterministic/tdd-classify.ts
function classifyCommit(files) {
  const real = files.filter((f) => f.length > 0);
  if (real.length === 0) return "empty";
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
      note: "no commits in base..HEAD \u2014 fail-closed (executor produced nothing)"
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
  if (commitFiles.length !== 1) return false;
  const files = commitFiles[0];
  const hasTest = files.some((f) => isTestPath(f));
  const hasImpl = files.some((f) => !isTestPath(f) && !f.endsWith(".md") && !f.startsWith("docs/"));
  return hasTest && hasImpl;
}
async function resolveBase(tools, baseRef, opts) {
  const remote = `origin/${baseRef}`;
  if (await tools.git.refExists(remote, opts)) return remote;
  if (await tools.git.refExists(baseRef, opts)) return baseRef;
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
    const tipSha = await ctx.tools.git.revParse("HEAD", opts);
    const memoized = ctx.memo?.getTdd(ctx.taskId, tipSha);
    if (memoized !== void 0) {
      return verdictToOutcome(memoized);
    }
    const commits = await ctx.tools.git.commits(base, ctx.taskId, opts);
    if (isSquashedHistory(commits.map((c) => c.files))) {
      const verdict2 = {
        ok: true,
        exempt: false,
        violations: [],
        note: "squashed history \u2014 TDD gate no-op"
      };
      ctx.memo?.putTdd(ctx.taskId, tipSha, verdict2);
      return verdictToOutcome(verdict2);
    }
    const exempt = ctx.exemptReader ? await ctx.exemptReader.isExempt(ctx.taskId) : false;
    const verdict = deriveTddVerdict(commits, exempt);
    ctx.memo?.putTdd(ctx.taskId, tipSha, verdict);
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
var coverageStrategy = {
  id: "coverage",
  async run(ctx) {
    const tolerance = ctx.config.quality.coverageRegressionTolerancePct;
    const opts = { cwd: ctx.worktree };
    const before = await ctx.tools.coverage.read("before", opts);
    const after = await ctx.tools.coverage.read("after", opts);
    if (before.state === "absent" && after.state === "absent") {
      return skip("coverage", "no-coverage-data");
    }
    if (before.state === "invalid" || after.state === "invalid") {
      const which = before.state === "invalid" ? "before" : "after";
      return ran("coverage", false, `coverage parse error: ${which} summary invalid`);
    }
    if (before.state === "absent" || after.state === "absent") {
      const which = before.state === "absent" ? "before" : "after";
      return ran("coverage", false, `coverage parse error: ${which} summary missing`);
    }
    const delta = coverageDelta(before.summary, after.summary);
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
var STRYKER_CONFIGS = [
  "stryker.config.json",
  "stryker.config.js",
  "stryker.config.mjs",
  "stryker.config.cjs",
  "stryker.conf.json",
  "stryker.conf.js",
  ".stryker.config.json",
  ".stryker.conf.json"
];
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
    const base = `origin/${ctx.baseRef}`;
    if (!await ctx.tools.git.refExists(base, opts)) {
      return ran("mutation", false, `base-missing: ${base} not found`);
    }
    const changed = await ctx.tools.git.changedFiles(base, opts);
    const scope = mutationScope(changed);
    if (scope.length === 0) {
      return skip("mutation", "no-mutable-changes");
    }
    const result = await ctx.tools.stryker.run(scope, opts);
    if (result.proc.truncated) {
      throw new Error(
        "mutation gate: stryker report truncated \u2014 refusing to parse a clipped payload"
      );
    }
    if (result.proc.code !== 0) {
      return ran("mutation", false, `stryker-failed: exit=${result.proc.code ?? "null"}`);
    }
    const report = result.report;
    if (report.report === "absent") {
      return ran("mutation", false, "no-report: stryker produced no report despite mutable files");
    }
    if (report.report === "unparseable") {
      return ran("mutation", false, "unparseable-report: stryker report JSON did not parse");
    }
    if (report.mutationScore === null) {
      return ran("mutation", false, "no-score: report has no .metrics.mutationScore");
    }
    const score = report.mutationScore;
    if (!scorePasses(score, target)) {
      return ran("mutation", false, `score-below-target: ${score} < ${target}`);
    }
    return ran("mutation", true, `mutation score ${score} >= ${target} (scope ${scope.length})`);
  }
};

// src/verifier/deterministic/strategies/sast.ts
var SAFE_TOKEN = /^[A-Za-z0-9._/=:+-]+$/;
function validateSecurityCommand(command) {
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  for (const t of tokens) {
    if (!SAFE_TOKEN.test(t)) {
      return { ok: false, reason: "unsafe_command", detail: `unsafe token '${t}'` };
    }
  }
  const bin = tokens[0];
  if (bin === void 0) {
    return { ok: false, reason: "unsafe_command", detail: "empty command" };
  }
  const runner = bin.includes("/") ? bin.slice(bin.lastIndexOf("/") + 1) : bin;
  const a1 = tokens[1];
  const a2 = tokens[2];
  let allowed = false;
  switch (runner) {
    case "semgrep":
    case "pytest":
    case "vitest":
    case "jest":
    case "mocha":
    case "phpunit":
    case "rspec":
      allowed = true;
      break;
    case "go":
    case "cargo":
    case "deno":
      allowed = a1 === "test";
      break;
    case "bundle":
      allowed = a1 === "exec" && a2 === "rspec";
      break;
    default:
      allowed = false;
  }
  if (!allowed) {
    return { ok: false, reason: "unallowed_runner", detail: `runner '${runner}' not allowlisted` };
  }
  return { ok: true, argv: tokens };
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
      return ran(
        "sast",
        true,
        `security findings present but non-blocking (allowFailures) ${detail}`
      );
    }
    return ran("sast", false, `security findings present ${detail}`);
  }
};

// src/verifier/deterministic/strategies/proc-strategy.ts
function procOutcome(id, label, result) {
  if (result.truncated) {
    throw new Error(`${id} gate: ${label} output truncated \u2014 refusing to judge a clipped run`);
  }
  return ran(id, result.code === 0, `${label} exit=${result.code ?? "null"}`);
}
function procStrategy(id, label, invoke) {
  return {
    id,
    async run(ctx) {
      return procOutcome(id, label, await invoke(ctx.tools, { cwd: ctx.worktree }));
    }
  };
}

// src/verifier/deterministic/strategies/type.ts
var typeStrategy = procStrategy(
  "type",
  "tsc --noEmit",
  (tools, opts) => tools.tsc.typecheck(opts)
);

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

// src/verifier/deterministic/strategies/build.ts
var buildStrategy = procStrategy(
  "build",
  "build",
  (tools, opts) => tools.build.build(opts)
);

// src/verifier/deterministic/gate-runner.ts
var log22 = createLogger("gate-runner");
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
    const memo = ctx.memo ?? new GateMemo();
    const report = [];
    const evidence = [];
    const skipped = [];
    const treeSha = await ctx.tools.git.treeSha({ cwd: ctx.worktree });
    for (const id of gates) {
      const cached = memo.getEvidence(id, treeSha);
      if (cached !== void 0) {
        report.push({ gate: id, outcome: { kind: "ran", evidence: cached } });
        evidence.push(cached);
        log22.debug(`gate ${id} served from tree-SHA evidence memo (${treeSha})`);
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
        memo
      };
      const outcome = await strategy.run(sctx);
      report.push({ gate: id, outcome });
      if (outcome.kind === "ran") {
        evidence.push(outcome.evidence);
        memo.putEvidence(id, treeSha, outcome.evidence);
      } else {
        skipped.push({ gate: outcome.gate, reason: outcome.reason });
        log22.debug(`gate ${id} skipped: ${outcome.reason}`);
      }
    }
    const verdict = deriveAllGatesVerdict(evidence);
    return { report, evidence, skipped, verdict };
  }
};

// src/verifier/deterministic/tools.ts
import { access as access2, readFile as readFile6 } from "node:fs/promises";
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
async function pathExists(absPath) {
  try {
    await access2(absPath);
    return true;
  } catch {
    return false;
  }
}
async function resolveLocalBin(cwd, tool, exists = pathExists) {
  let dir = path2.resolve(cwd);
  for (; ; ) {
    const candidate = path2.join(dir, "node_modules", ".bin", tool);
    if (await exists(candidate)) return candidate;
    const parent = path2.dirname(dir);
    if (parent === dir) return null;
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
async function runTool(resolve2, tool, toolArgs, opts) {
  const localBin = await resolve2(tool, opts);
  if (localBin === null) return missingBinResult(tool, opts.cwd);
  return exec(localBin, [...toolArgs], { cwd: opts.cwd });
}
var DefaultVitestTool = class {
  constructor(resolve2 = defaultLocalBinResolver) {
    this.resolve = resolve2;
  }
  async run(files, opts) {
    const args = ["run", "--coverage.enabled=false", ...files];
    return toProc(await runTool(this.resolve, "vitest", args, opts));
  }
};
var DefaultTscTool = class {
  constructor(resolve2 = defaultLocalBinResolver) {
    this.resolve = resolve2;
  }
  async typecheck(opts) {
    return toProc(await runTool(this.resolve, "tsc", ["--noEmit"], opts));
  }
};
var DefaultEslintTool = class {
  constructor(resolve2 = defaultLocalBinResolver) {
    this.resolve = resolve2;
  }
  async lint(opts) {
    return toProc(await runTool(this.resolve, "eslint", ["."], opts));
  }
};
var DefaultBuildTool = class {
  async build(opts) {
    return toProc(await exec("npm", ["run", "build"], { cwd: opts.cwd }));
  }
};
var DefaultSemgrepTool = class {
  async run(command, opts) {
    const [bin, ...rest] = command;
    if (bin === void 0) {
      throw new Error("DefaultSemgrepTool: empty command");
    }
    return toProc(await exec(bin, rest, { cwd: opts.cwd }));
  }
};
var DefaultStrykerTool = class _DefaultStrykerTool {
  constructor(resolve2 = defaultLocalBinResolver) {
    this.resolve = resolve2;
  }
  /** Report path relative to the worktree (stryker html/json reporter default). */
  static REPORT_PATH = "reports/mutation/mutation.json";
  async run(mutate, opts) {
    const csv = mutate.join(",");
    const proc2 = toProc(await runTool(this.resolve, "stryker", ["run", "--mutate", csv], opts));
    const reportPath = path2.join(opts.cwd, _DefaultStrykerTool.REPORT_PATH);
    let raw;
    try {
      raw = await readFile6(reportPath, "utf8");
    } catch {
      return { proc: proc2, report: { report: "absent" } };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { proc: proc2, report: { report: "unparseable" } };
    }
    const score = extractMutationScore(parsed);
    return { proc: proc2, report: { report: "present", mutationScore: score } };
  }
};
function extractMutationScore(report) {
  if (typeof report !== "object" || report === null) return null;
  const metrics = report.metrics;
  if (typeof metrics !== "object" || metrics === null) return null;
  const score = metrics.mutationScore;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}
var DefaultCoverageReader = class {
  async read(label, opts) {
    const file = path2.join(opts.cwd, "coverage", `${label}-coverage-summary.json`);
    let raw;
    try {
      raw = await readFile6(file, "utf8");
    } catch {
      return { state: "absent" };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: "invalid" };
    }
    const summary = parseCoverageSummary(parsed);
    return summary === null ? { state: "invalid" } : { state: "ok", summary };
  }
};
var DefaultFsProbe = class {
  async exists(relPath, opts) {
    try {
      await access2(path2.join(opts.cwd, relPath));
      return true;
    } catch {
      return false;
    }
  }
  async existsAny(relPaths, opts) {
    for (const rel of relPaths) {
      if (await this.exists(rel, opts)) return true;
    }
    return false;
  }
};
function readMetric(total, key) {
  const v = total[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && v !== null) {
    const pct = v.pct;
    if (typeof pct === "number" && Number.isFinite(pct)) return pct;
  }
  return null;
}
function parseCoverageSummary(report) {
  if (typeof report !== "object" || report === null) return null;
  const total = report.total;
  if (typeof total !== "object" || total === null) return null;
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
    const r = await this.git(
      ["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`],
      opts.cwd
    );
    if (r.code !== 0) {
      throw new Error(`git diff vs ${base} failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
    }
    assertNotTruncated(r, "git diff --name-only");
    return splitLines(r.stdout);
  }
  async commits(base, taskId, opts) {
    const log32 = await this.git(["log", "--format=%H", `${base}..HEAD`], opts.cwd);
    if (log32.code !== 0) {
      throw new Error(
        `git log ${base}..HEAD failed (code=${log32.code ?? "null"}): ${log32.stderr.trim()}`
      );
    }
    assertNotTruncated(log32, "git log (tdd classification)");
    const shas = splitLines(log32.stdout).reverse();
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
        const firstParent = parentShas[0];
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
        const dt = await this.git(
          ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
          opts.cwd
        );
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
function defaultGateTools() {
  return {
    git: new DefaultGitProbe(),
    vitest: new DefaultVitestTool(),
    tsc: new DefaultTscTool(),
    eslint: new DefaultEslintTool(),
    build: new DefaultBuildTool(),
    semgrep: new DefaultSemgrepTool(),
    stryker: new DefaultStrykerTool(),
    coverage: new DefaultCoverageReader(),
    fs: new DefaultFsProbe()
  };
}

// src/verifier/holdout/split.ts
import { createHash } from "node:crypto";
function holdoutCount(total, percent) {
  if (percent <= 0 || total <= 1) {
    return 0;
  }
  let count = Math.floor(total * percent / 100);
  if (count < 1) {
    count = 1;
  }
  if (count >= total) {
    count = total - 1;
  }
  return count;
}
function rankKey(seed, index) {
  return createHash("sha256").update(`${seed}\0${index}`).digest("hex");
}
function splitHoldout(criteria, percent, seed) {
  const total = criteria.length;
  const count = holdoutCount(total, percent);
  if (count === 0) {
    return { visible: [...criteria], withheld: [] };
  }
  const withheldIdx = new Set(
    criteria.map((_, i) => ({ i, key: rankKey(seed, i) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i).slice(0, count).map((r) => r.i)
  );
  const visible = [];
  const withheld = [];
  criteria.forEach((c, i) => {
    (withheldIdx.has(i) ? withheld : visible).push(c);
  });
  return { visible, withheld };
}

// src/verifier/holdout/store.ts
import { mkdir as mkdir8, readFile as readFile7 } from "node:fs/promises";
import { dirname as dirname6, join as join10 } from "node:path";
var HoldoutRecordSchema = external_exports.object({
  task_id: external_exports.string().min(1),
  withheld_criteria: external_exports.array(external_exports.string()),
  total_criteria: external_exports.number().int().nonnegative(),
  withheld_count: external_exports.number().int().nonnegative()
}).strict().refine((r) => r.withheld_count === r.withheld_criteria.length, {
  message: "withheld_count must equal withheld_criteria.length"
});
function parseHoldoutRecord(raw, source) {
  const result = HoldoutRecordSchema.safeParse(raw);
  if (!result.success) {
    const where = source ? ` (${source})` : "";
    throw new Error(`invalid holdout record${where}: ${result.error.message}`);
  }
  return result.data;
}
function makeHoldoutRecord(taskId, withheld, totalCriteria) {
  return {
    task_id: taskId,
    withheld_criteria: [...withheld],
    total_criteria: totalCriteria,
    withheld_count: withheld.length
  };
}
var FsHoldoutStore = class {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  path(runId, taskId) {
    const safe = validateId(taskId, "task_id");
    return join10(runDir(this.dataDir, runId), "holdouts", `${safe}.json`);
  }
  async put(runId, record) {
    const path3 = this.path(runId, record.task_id);
    await mkdir8(dirname6(path3), { recursive: true });
    await atomicWriteFile(path3, stringifyJson(record));
  }
  async get(runId, taskId) {
    const path3 = this.path(runId, taskId);
    const raw = await readFile7(path3, "utf8");
    return parseHoldoutRecord(parseJson(raw, path3), path3);
  }
  async has(runId, taskId) {
    try {
      await readFile7(this.path(runId, taskId), "utf8");
      return true;
    } catch {
      return false;
    }
  }
};

// src/verifier/holdout/validate.ts
function clampThreshold(raw) {
  if (!Number.isFinite(raw)) {
    return 80;
  }
  const t = Math.floor(raw);
  return t < 1 ? 1 : t;
}
function buildHoldoutPrompt(record, worktree, baseRef) {
  const lines = [];
  if (worktree !== void 0 && worktree.length > 0) {
    if (baseRef === void 0 || baseRef.length === 0) {
      throw new Error(
        "buildHoldoutPrompt: baseRef is required when a worktree is provided (the per-run staging base ref the worktree forked from)"
      );
    }
    lines.push(
      `The implementation lives in the task worktree at: ${worktree}`,
      `Inspect it with: git -C ${worktree} diff ${baseRef}`,
      `Do NOT rely on your own working directory \u2014 it is a fresh checkout with no diff.`,
      ""
    );
  }
  lines.push(
    `Holdout validation for task ${record.task_id}.`,
    "",
    "The implementer was NOT shown the following acceptance criteria during execution.",
    "Independently verify whether the current diff satisfies each one.",
    "",
    `Withheld criteria (${record.withheld_count} of ${record.total_criteria} total):`,
    ...record.withheld_criteria.map((c, i) => `  ${i + 1}. ${c}`),
    "",
    "Respond with a single JSON object, no prose, exactly this shape:",
    '{ "criteria": [ { "criterion": "<exact text from above>", "satisfied": true|false, "evidence": "<file:line or short rationale>" }, ... ] }',
    "",
    "One entry per withheld criterion, in the same order. A missing entry is treated as a failure."
  );
  return lines.join("\n");
}
function extractCriteria(raw) {
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1]);
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.criteria)) {
        return parsed.criteria;
      }
    } catch {
    }
  }
  throw new Error("holdout validator output has no parseable JSON object with .criteria");
}
function parseHoldoutVerdicts(raw) {
  return extractCriteria(raw).map((entry) => {
    const e = entry ?? {};
    return {
      criterion: typeof e.criterion === "string" ? e.criterion : "",
      satisfied: e.satisfied === true,
      evidence: typeof e.evidence === "string" ? e.evidence : ""
    };
  });
}
function checkHoldout(record, verdicts, rawThreshold) {
  const threshold = clampThreshold(rawThreshold);
  const criteria = record.withheld_criteria.map((criterion, i) => {
    const r = verdicts[i];
    const satisfied2 = r !== void 0 && r.criterion === criterion && r.satisfied === true && r.evidence.trim().length > 0;
    return { criterion, satisfied: satisfied2, evidence: r?.evidence ?? null };
  });
  const satisfied = criteria.filter((c) => c.satisfied).length;
  const withheld = record.withheld_count;
  const passPct = withheld > 0 ? Math.floor(satisfied * 100 / withheld) : 100;
  return {
    status: passPct >= threshold ? "pass" : "fail",
    satisfied,
    withheld,
    passPct,
    threshold,
    criteria
  };
}
function holdoutEvidence(result) {
  return {
    gate: "holdout",
    observed: result.status === "pass",
    detail: `holdout ${result.satisfied}/${result.withheld} (${result.passPct}% ${result.status === "pass" ? "\u2265" : "<"} ${result.threshold}%)`
  };
}

// src/verifier/holdout/verdict-store.ts
import { mkdir as mkdir9, readFile as readFile8 } from "node:fs/promises";
import { dirname as dirname7, join as join11 } from "node:path";
var HoldoutVerdictSchema = external_exports.object({
  criterion: external_exports.string(),
  satisfied: external_exports.boolean(),
  evidence: external_exports.string()
});
var HoldoutVerdictsSchema = external_exports.array(HoldoutVerdictSchema);
var FsHoldoutVerdictStore = class {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  path(runId, taskId) {
    const safe = validateId(taskId, "task_id");
    return join11(runDir(this.dataDir, runId), "holdouts", `${safe}.verdicts.json`);
  }
  async put(runId, taskId, verdicts) {
    const path3 = this.path(runId, taskId);
    await mkdir9(dirname7(path3), { recursive: true });
    await atomicWriteFile(path3, stringifyJson([...verdicts]));
  }
  async get(runId, taskId) {
    const path3 = this.path(runId, taskId);
    const raw = await readFile8(path3, "utf8");
    return HoldoutVerdictsSchema.parse(parseJson(raw, path3));
  }
  async has(runId, taskId) {
    try {
      await readFile8(this.path(runId, taskId), "utf8");
      return true;
    } catch {
      return false;
    }
  }
};

// src/driver/finalize.ts
var log23 = createLogger("finalize");
var FACTORY_ISSUE_LABEL = "factory";
function prdDoneComment(report, rollupResult) {
  const prRef = rollupResult.url ? `[#${rollupResult.number}](${rollupResult.url})` : `#${rollupResult.number}`;
  return `PRD delivered \u2014 all ${report.totals.shipped} task(s) shipped via rollup PR ${prRef}.

Spec: \`${report.spec_id}\` \xB7 Run: \`${report.run_id}\``;
}
function rollupTitle(report) {
  return `factory: ${report.spec_id} \u2192 develop (PRD #${report.issue_number})`;
}
async function fileFailureIssues(deps, report) {
  if (report.failures.length === 0) return 0;
  const existing = new Set(
    (await deps.gh.issueList({ repo: report.repo, labels: [FACTORY_ISSUE_LABEL], state: "all" })).map((i) => i.title)
  );
  let filed = 0;
  for (const failure of report.failures) {
    const issue = renderFailureIssue(failure, report);
    if (existing.has(issue.title)) {
      log23.info(`issue already filed for dropped task '${failure.task_id}' \u2014 skipping duplicate`);
      continue;
    }
    await deps.gh.issueCreate({
      title: issue.title,
      body: issue.body,
      repo: report.repo,
      labels: [FACTORY_ISSUE_LABEL, `factory:${failure.failure_class}`]
    });
    existing.add(issue.title);
    filed += 1;
  }
  return filed;
}
async function finalizeRun(deps, runId) {
  const now = deps.nowIso ?? nowIso();
  const run9 = await deps.state.read(runId);
  const terminal = decideFinalize(run9).run_status;
  const report = buildPartialReport({ ...run9, status: terminal }, deps.spec, { now });
  const markdown = renderPartialReportMarkdown(report);
  await atomicWriteFile(runReportPath(deps.dataDir, runId), markdown);
  await recordRunFinalized(deps.dataDir, report, { now });
  const issuesFiled = await fileFailureIssues(deps, report);
  let rollupResult;
  if (terminal === "completed") {
    const stagingBranch = resolveStagingBranch(runId, run9.staging_branch);
    await deps.git.fetch("origin", deps.config.git.baseBranch);
    await deps.git.mergeFfOrCommit(stagingBranch, `origin/${deps.config.git.baseBranch}`);
    await deps.git.push("origin", stagingBranch);
    rollupResult = await rollup({
      ghClient: deps.gh,
      stagingBranch,
      baseBranch: deps.config.git.baseBranch,
      title: rollupTitle(report),
      body: markdown,
      merge: deps.shipMode === "live",
      ...deps.rollup ?? {}
    });
    if (rollupResult.merged) {
      if (!rollupResult.resumed) {
        await deps.gh.issueComment({
          repo: report.repo,
          number: report.issue_number,
          body: prdDoneComment(report, rollupResult)
        });
      }
      await deps.gh.issueClose({
        repo: report.repo,
        number: report.issue_number
      });
      await deps.gh.deleteProtection(deps.owner, deps.repo, stagingBranch);
      await deps.gh.deleteRemoteBranch(deps.owner, deps.repo, stagingBranch);
    }
  } else {
    log23.warn(`run '${runId}': ${terminal} \u2014 develop untouched (no rollup, PRD left open)`);
  }
  const finalized = await deps.state.finalize(runId, terminal);
  log23.info(
    `run '${runId}' finalized: ${terminal} (${report.totals.shipped} shipped, ${report.totals.failed} failed, ${issuesFiled} issue(s) filed${rollupResult ? `, rollup #${rollupResult.number} merged=${rollupResult.merged}` : ", no rollup"})`
  );
  return { run: finalized, report, ...rollupResult ? { rollup: rollupResult } : {}, issuesFiled };
}

// src/driver/transitions.ts
var log24 = createLogger("transitions");
function markInFlight(deps, runId, taskId, stage) {
  const status = stageToInFlightStatus(stage);
  return deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    status,
    stage,
    started_at: t.started_at ?? nowIso()
  }));
}
async function completeTask(deps, runId, taskId) {
  await deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    status: "done",
    ended_at: t.ended_at ?? nowIso()
  }));
  return { done: true, outcome: { outcome: "done" } };
}
async function dropTask(deps, runId, taskId, failureClass, reason) {
  log24.warn(`task '${taskId}' dropped (${failureClass}): ${reason}`);
  await deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    status: "dropped",
    failure_class: failureClass,
    failure_reason: reason,
    ended_at: t.ended_at ?? nowIso()
  }));
}
async function dropStep(deps, runId, taskId, failureClass, reason) {
  await dropTask(deps, runId, taskId, failureClass, reason);
  return { done: true, outcome: { outcome: "dropped", failure_class: failureClass, reason } };
}
async function escalateOrDrop(deps, runId, taskId, decision, resumeStage) {
  if (decision.action === "drop") {
    return dropStep(deps, runId, taskId, decision.failureClass, decision.reason);
  }
  const run9 = await deps.state.read(runId);
  const task = run9.tasks[taskId];
  if (task === void 0) {
    throw new Error(`transitions: task '${taskId}' vanished from run '${runId}'`);
  }
  if (task.escalation_rung >= ESCALATION_CAP) {
    return dropStep(
      deps,
      runId,
      taskId,
      "capability-budget",
      `producer escalation cap (${ESCALATION_CAP}) reached without clearing the floor: ${decision.reason}`
    );
  }
  const nextRung = task.escalation_rung + 1;
  await deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    escalation_rung: nextRung,
    reviewers: []
  }));
  log24.info(
    `task '${taskId}' escalating to rung ${nextRung}; resuming at '${resumeStage}' (${decision.reason})`
  );
  return { done: false, stage: resumeStage };
}
function classifyProducerFailure(outcome) {
  switch (outcome.status) {
    case "blocked-escalate":
      return classifyFailure({
        kind: "producer-status",
        status: "blocked-escalate",
        reason: outcome.reason
      });
    case "needs-context":
      return classifyFailure({
        kind: "producer-status",
        status: "needs-context",
        reason: outcome.reason
      });
    case "error":
      return classifyFailure({ kind: "producer-status", status: "error", reason: outcome.reason });
    case "done":
      throw new Error("transitions: classifyProducerFailure called on a 'done' outcome");
    default:
      return assertNever(outcome);
  }
}
async function applyProducerOutcome(deps, runId, taskId, opts, outcome) {
  if (outcome.status === "done") {
    await deps.state.updateTask(runId, taskId, (t) => ({ ...t, producer_role: opts.role }));
    return { done: false, stage: opts.stageAfter };
  }
  return escalateOrDrop(deps, runId, taskId, classifyProducerFailure(outcome), opts.stage);
}

// src/driver/paths.ts
import { join as join12 } from "node:path";
function taskWorktreePath(dataDir, runId, taskId) {
  validateId(runId, "run-id");
  validateId(taskId, "task-id");
  return join12(worktreesRoot(dataDir), runId, taskId);
}

// src/driver/handlers.ts
function makeStageHandlers(deps) {
  function requireTask3(ctx, stage) {
    if (ctx.task === void 0) {
      throw new Error(`handlers: stage '${stage}' requires a task but ctx.task is absent`);
    }
    return ctx.task;
  }
  function splitFor(config, runId, specTask) {
    return splitHoldout(
      specTask.acceptance_criteria,
      config.quality.holdoutPercent,
      `${runId}:${specTask.task_id}`
    );
  }
  function priorFailureNote(rung) {
    const prior = Math.max(0, rung - 1);
    return {
      rung: prior,
      summary: `prior attempt at rung ${prior} did not clear the verifier floor`
    };
  }
  async function producerSpawn(role, specTask, runId, rung, stageAfter) {
    const dial = dialForRung(specTask.risk_tier, rung, deps.config);
    const split = splitFor(deps.config, runId, specTask);
    const context = buildProducerContext({
      taskId: specTask.task_id,
      title: specTask.title,
      description: specTask.description,
      visibleCriteria: split.visible,
      files: specTask.files,
      rung,
      priorFailures: dial.injectsPriorFailure ? [priorFailureNote(rung)] : []
    });
    const promptRef = await deps.artifacts.putProducerContext(
      runId,
      specTask.task_id,
      `${role}-r${rung}`,
      context
    );
    const manifest = parseSpawnManifest({
      stage_after: stageAfter,
      agents: [
        {
          role,
          model: dial.model,
          // No executor-specific turn budget exists; both producer roles share the
          // test-writer cap (documented WS10 decision).
          max_turns: deps.config.testWriter.maxTurns,
          prompt_ref: promptRef
        }
      ]
    });
    return spawn2(manifest);
  }
  return {
    /**
     * preflight: create the per-task worktree forked off the staging tip (D12
     * base-is-staging-tip assertion lives inside createTaskWorktree), then advance
     * to the tests stage. The run-scoped branch is deterministic from (run, task),
     * so it is not threaded through state here — ship recomputes it.
     */
    async preflight(ctx) {
      const task = requireTask3(ctx, "preflight");
      const worktree = taskWorktreePath(deps.dataDir, ctx.run.run_id, task.task_id);
      await createTaskWorktree({
        gitClient: deps.git,
        runId: ctx.run.run_id,
        taskId: task.task_id,
        path: worktree,
        base: resolveStagingBranch(ctx.run.run_id, ctx.run.staging_branch)
      });
      await (deps.provision ?? provisionWorktree)({
        path: worktree,
        setupCommand: deps.config.quality.setupCommand
      });
      return advance("tests");
    },
    /**
     * tests: PERSIST the holdout answer-key (the only stage that does — exec merely
     * recomputes the split), then either skip the test-writer (tdd_exempt → advance
     * to exec) or spawn the test-writer for the current rung (resume at exec).
     */
    async tests(ctx) {
      const task = requireTask3(ctx, "tests");
      const specTask = specTaskOf(deps.spec, task.task_id);
      const split = splitFor(deps.config, ctx.run.run_id, specTask);
      if (split.withheld.length > 0) {
        await deps.holdout.put(
          ctx.run.run_id,
          makeHoldoutRecord(task.task_id, split.withheld, specTask.acceptance_criteria.length)
        );
      }
      if (specTask.tdd_exempt === true) {
        return advance("exec");
      }
      return producerSpawn("test-writer", specTask, ctx.run.run_id, task.escalation_rung, "exec");
    },
    /**
     * exec: spawn the executor for the current rung against the holdout-stripped
     * visible criteria (recomputed from the same seed — never re-persisted), resume
     * at verify.
     */
    async exec(ctx) {
      const task = requireTask3(ctx, "exec");
      const specTask = specTaskOf(deps.spec, task.task_id);
      return producerSpawn("executor", specTask, ctx.run.run_id, task.escalation_rung, "verify");
    },
    /**
     * verify reporter: run the deterministic gates, then either spawn the
     * risk-invariant panel (no reviewers yet) or DERIVE the floor from the
     * already-recorded reviewers + gate evidence. Holdout evidence is folded
     * separately by the coroutine (the holdout-validator runs as an out-of-band sidecar);
     * this reporter never spawns.
     */
    async verify(ctx) {
      const task = requireTask3(ctx, "verify");
      const gateCtx = {
        runId: ctx.run.run_id,
        taskId: task.task_id,
        worktree: taskWorktreePath(deps.dataDir, ctx.run.run_id, task.task_id),
        baseRef: resolveStagingBranch(ctx.run.run_id, ctx.run.staging_branch),
        config: deps.config,
        tools: deps.tools
      };
      const gate = await new GateRunner().run(gateCtx);
      if (task.reviewers.length === 0) {
        return spawn2(
          buildPanelManifest(
            "verify",
            resolveReviewModel(deps.config),
            deps.config.review.maxTurnsDeep
          )
        );
      }
      const holdoutExpected = await deps.holdout.has(ctx.run.run_id, task.task_id);
      if (holdoutExpected) {
        const verdictStore = new FsHoldoutVerdictStore(deps.dataDir);
        const hasVerdicts = await verdictStore.has(ctx.run.run_id, task.task_id);
        if (!hasVerdicts) {
          return spawn2(
            buildPanelManifest(
              "verify",
              resolveReviewModel(deps.config),
              deps.config.review.maxTurnsDeep
            )
          );
        }
      }
      const floor = deriveFloorVerdict({ reviewers: task.reviewers }, gate.evidence);
      if (floor.passed) {
        return advance("ship");
      }
      return waitRetry(
        "verify",
        floorBlockReason(task.reviewers, gate.evidence),
        ctx.attempt ?? 1,
        ESCALATION_CAP + 1
      );
    },
    /**
     * ship (CLI single-step reporter): open the task PR into staging IDEMPOTENTLY
     * (look up by head first — Δ P), then mark the task done. Merge is loop-owned
     * (MergeSerializer) and not performed here; `pr_number` recording is the
     * driver's job (the reporter cannot write state).
     *
     * NOTE: this reporter is superseded on the live path by `shipTask` in
     * `src/driver/ship.ts` (coroutine routes `ship` there directly). Kept
     * consistent with the per-run branch so it does not become a latent trap once
     * the shared staging branch is removed.
     */
    async ship(ctx) {
      const task = requireTask3(ctx, "ship");
      const specTask = specTaskOf(deps.spec, task.task_id);
      const branch = runScopedBranch(ctx.run.run_id, task.task_id);
      await createTaskPrIdempotent({
        ghClient: deps.gh,
        branch,
        title: specTask.title,
        body: shipBody(ctx.run.run_id, specTask),
        base: resolveStagingBranch(ctx.run.run_id, ctx.run.staging_branch)
      });
      return taskDone();
    },
    /**
     * finalize (run-level, terminal-by-construction): the pure {@link decideFinalize}
     * over the run's task-status map. Throws if any task is non-terminal (it must
     * never be called with in-flight work) — never spins.
     */
    finalize(ctx) {
      return Promise.resolve(decideFinalize(ctx.run));
    }
  };
}
function specTaskOf(spec, taskId) {
  const found = spec.tasks.find((t) => t.task_id === taskId);
  if (found === void 0) {
    throw new Error(
      `handlers: task '${taskId}' is not present in spec '${spec.spec_id}' \u2014 run/spec drift`
    );
  }
  return found;
}
function shipBody(runId, specTask) {
  return [
    `Factory task \`${specTask.task_id}\` \u2014 ${specTask.title}`,
    "",
    specTask.description,
    "",
    `Run: \`${runId}\``,
    `Risk tier: ${specTask.risk_tier}`
  ].join("\n");
}

// src/driver/artifacts.ts
import { mkdir as mkdir10, readFile as readFile9 } from "node:fs/promises";
import { dirname as dirname8, join as join13 } from "node:path";
function producerRef(taskId, label) {
  return `prompts/${taskId}/${label}.json`;
}
var FsArtifactStore = class {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  absPath(runId, ref) {
    return join13(runDir(this.dataDir, runId), ref);
  }
  async putProducerContext(runId, taskId, label, context) {
    const ref = producerRef(taskId, label);
    const path3 = this.absPath(runId, ref);
    await mkdir10(dirname8(path3), { recursive: true });
    await atomicWriteFile(path3, stringifyJson(context));
    return ref;
  }
  async getProducerContext(runId, promptRef) {
    const path3 = this.absPath(runId, promptRef);
    const raw = await readFile9(path3, "utf8");
    return parseJson(raw, path3);
  }
};

// src/driver/fold.ts
import { readFile as readFile10 } from "node:fs/promises";
import { join as join14 } from "node:path";
var log25 = createLogger("fold");
async function persistStepCursor(deps, runId, taskId, step) {
  if (!step.done) {
    await markInFlight(deps, runId, taskId, step.stage);
  }
}
async function readJsonInput(path3) {
  const raw = await readFile10(path3, "utf8");
  return parseJson(raw, path3);
}
function producerStageInfo(stage) {
  if (stage === "tests") return { role: "test-writer", stage: "tests", after: "exec" };
  if (stage === "exec") return { role: "executor", stage: "exec", after: "verify" };
  throw new UsageError(`stage must be a producer stage (tests | exec), got '${stage}'`);
}
async function applyRecordProducer(state, runId, taskId, stage, statusLine) {
  const info = producerStageInfo(stage);
  if (nextStage(info.stage) !== info.after) {
    throw new Error(
      `record-producer: stage order drift \u2014 nextStage('${info.stage}') !== '${info.after}'`
    );
  }
  const run9 = await state.read(runId);
  if (run9.tasks[taskId] === void 0) {
    throw new Error(`record-producer: run '${runId}' has no task '${taskId}'`);
  }
  const outcome = parseProducerStatus(statusLine);
  const step = await applyProducerOutcome(
    { state },
    runId,
    taskId,
    { role: info.role, stage: info.stage, stageAfter: info.after },
    outcome
  );
  await persistStepCursor({ state }, runId, taskId, step);
  return { run_id: runId, task_id: taskId, step };
}
function parseVerdictsFailClosed(raw) {
  try {
    return parseHoldoutVerdicts(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log25.warn(`holdout validator output unparseable \u2014 failing closed (0 satisfied): ${detail}`);
    return [];
  }
}
async function applyRecordHoldout(deps, runId, taskId, verdictStore, raw) {
  if (!await deps.holdout.has(runId, taskId)) {
    throw new Error(
      `record-holdout: task '${taskId}' has no withheld answer key \u2014 nothing to validate (applyRecordHoldout must only fold when the coroutine surfaced a holdout sidecar)`
    );
  }
  const record = await deps.holdout.get(runId, taskId);
  const verdicts = parseVerdictsFailClosed(raw);
  await verdictStore.put(runId, taskId, verdicts);
  const check = checkHoldout(record, verdicts, deps.config.quality.holdoutPassRate);
  return { run_id: runId, task_id: taskId, evidence: holdoutEvidence(check), check };
}
var REPLAY_IDENTITY = "orchestrator-replay";
async function buildWorktreeSource(worktree, reviews) {
  const files = /* @__PURE__ */ new Set();
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (finding.file !== void 0) files.add(finding.file);
    }
  }
  const lines = /* @__PURE__ */ new Map();
  for (const file of files) {
    try {
      const text = await readFile10(join14(worktree, file), "utf8");
      lines.set(file, text.split("\n"));
    } catch {
      lines.set(file, null);
    }
  }
  return { readLines: (file) => lines.get(file) ?? null };
}
function makeReplayRunnerFactory(input) {
  const byReviewer = /* @__PURE__ */ new Map();
  for (const v of input.verifications) byReviewer.set(v.reviewer, v.verdicts);
  return (review) => {
    const queues = /* @__PURE__ */ new Map();
    for (const v of byReviewer.get(review.reviewer) ?? []) {
      const key = `${v.file}:${v.line}`;
      const arr = queues.get(key) ?? [];
      arr.push(v);
      queues.set(key, arr);
    }
    return {
      identity: REPLAY_IDENTITY,
      confirm(finding) {
        const key = `${finding.file}:${finding.line}`;
        const next = queues.get(key)?.shift();
        if (next === void 0) {
          return Promise.reject(
            new Error(
              `record-reviews: no pre-recorded finding-verifier verdict for reviewer '${review.reviewer}' finding at ${key} \u2014 every citation-verified blocking finding must carry an orchestrator-collected verdict`
            )
          );
        }
        return Promise.resolve({ holds: next.holds, note: next.note });
      }
    };
  };
}
async function applyRecordReviews(deps, runId, taskId, verdictStore, input) {
  const run9 = await deps.state.read(runId);
  const task = run9.tasks[taskId];
  if (task === void 0) {
    throw new Error(`record-reviews: run '${runId}' has no task '${taskId}'`);
  }
  const worktree = taskWorktreePath(deps.dataDir, runId, taskId);
  const reviews = input.reviews.map(parseRawReview);
  const source = await buildWorktreeSource(worktree, reviews);
  const makeRunner2 = makeReplayRunnerFactory(input);
  const gateCtx = {
    runId,
    taskId,
    worktree,
    baseRef: resolveStagingBranch(runId, run9.staging_branch),
    config: deps.config,
    tools: deps.tools
  };
  const gate = await new GateRunner().run(gateCtx);
  const gateEvidence = [...gate.evidence];
  if (await deps.holdout.has(runId, taskId)) {
    const record = await deps.holdout.get(runId, taskId);
    const verdicts = await verdictStore.get(runId, taskId);
    gateEvidence.push(
      holdoutEvidence(checkHoldout(record, verdicts, deps.config.quality.holdoutPassRate))
    );
  }
  const panel = await runPanel({
    reviews,
    source,
    makeRunner: makeRunner2,
    gateEvidence,
    stage: "verify",
    attempt: task.escalation_rung + 1,
    maxAttempts: ESCALATION_CAP + 1,
    ...input.crossVendorAbsent !== void 0 ? { crossVendor: { status: "absent", reason: input.crossVendorAbsent.reason } } : {}
  });
  if (panel.crossVendorAbsence !== void 0) {
    log25.warn(
      `task '${taskId}' verify ran WITHOUT an independent cross-vendor reviewer: ` + panel.crossVendorAbsence.reason
    );
  }
  let step;
  if (panel.result.kind === "advance") {
    const nextStageVal = panel.result.to;
    const nextStatus = stageToInFlightStatus(nextStageVal);
    await deps.state.updateTask(runId, taskId, (t) => ({
      ...t,
      reviewers: [...panel.reviewerResults],
      stage: nextStageVal,
      status: nextStatus
    }));
    step = { done: false, stage: nextStageVal };
  } else if (panel.result.kind === "wait-retry") {
    step = await escalateOrDrop(
      deps,
      runId,
      taskId,
      classifyFailure({ kind: "floor-blocked", reason: panel.result.reason }),
      "exec"
    );
    await persistStepCursor(deps, runId, taskId, step);
  } else {
    throw new Error(`record-reviews: unexpected panel result kind '${panel.result.kind}'`);
  }
  return {
    run_id: runId,
    task_id: taskId,
    step,
    reviewers: panel.reviewerResults,
    floor: panel.floor,
    ...panel.crossVendorAbsence !== void 0 ? { crossVendorAbsence: panel.crossVendorAbsence } : {}
  };
}

// src/driver/results.ts
var SPAWN_STAGES = ["tests", "exec", "verify"];
var FoldKeySchema = external_exports.object({ stage: external_exports.enum(SPAWN_STAGES), rung: external_exports.number().int().min(0) }).strict();
var ProducerResultSchema = external_exports.object({ status: external_exports.string().min(1) }).strict();
var HoldoutResultSchema = external_exports.object({ raw: external_exports.string().min(1) }).strict();
var ReviewsResultSchema = external_exports.object({
  reviews: external_exports.array(external_exports.unknown()).min(1),
  verifications: external_exports.array(
    external_exports.object({
      reviewer: external_exports.string().min(1),
      verdicts: external_exports.array(
        external_exports.object({
          file: external_exports.string().min(1),
          line: external_exports.number().int().positive(),
          holds: external_exports.boolean(),
          note: external_exports.string()
        }).strict()
      )
    }).strict()
  ),
  crossVendorAbsent: external_exports.object({ reason: external_exports.string().min(1) }).strict().optional()
}).strict();
var DriveResultsSchema = external_exports.object({
  fold_key: FoldKeySchema,
  producer: ProducerResultSchema.optional(),
  holdout: HoldoutResultSchema.optional(),
  reviews: ReviewsResultSchema.optional()
}).strict().refine((r) => r.producer !== void 0 !== (r.reviews !== void 0), {
  message: "drive results must carry exactly one of 'producer' or 'reviews'"
}).refine((r) => r.holdout === void 0 || r.reviews !== void 0, {
  message: "'holdout' results only accompany 'reviews'"
});
function parseDriveResults(raw) {
  return DriveResultsSchema.parse(raw);
}
function isSpawnStage(stage) {
  return SPAWN_STAGES.includes(stage);
}

// src/driver/quota-gate.ts
var log26 = createLogger("quota-gate");
async function applyQuotaGate(deps, runId, mode = "session") {
  if (mode === "workflow") return null;
  const reading = await deps.usage.read();
  const decision = evaluate(reading, deps.config, deps.now());
  if (decision.kind === "proceed") {
    return null;
  }
  switch (decision.kind) {
    case "pause-5h":
    case "suspend-7d": {
      const patch = buildCheckpoint(decision);
      log26.warn(`run '${runId}' ${decision.kind}: ${decision.reason}`);
      const run9 = await deps.state.update(runId, (s) => ({
        ...s,
        status: patch.status,
        quota: patch.quota
      }));
      return {
        scope: decision.kind === "pause-5h" ? "5h" : "7d",
        reason: decision.reason,
        resets_at_epoch: decision.resetsAtEpoch,
        run: run9
      };
    }
    case "unavailable-halt": {
      log26.warn(`run '${runId}' quota unavailable \u2014 suspending: ${decision.reason}`);
      const run9 = await deps.state.update(runId, (s) => ({
        ...s,
        status: "suspended",
        quota: void 0
      }));
      return { scope: "unavailable", reason: decision.reason, run: run9 };
    }
    default:
      return assertNever(decision);
  }
}

// src/driver/ship.ts
var log27 = createLogger("ship");
function requireTask(ctx) {
  if (ctx.task === void 0) {
    throw new Error("ship: stage 'ship' requires a task but ctx.task is absent");
  }
  return ctx.task;
}
async function shipTask(deps, ctx) {
  const task = requireTask(ctx);
  const runId = ctx.run.run_id;
  const specTask = specTaskOf(deps.spec, task.task_id);
  const branch = runScopedBranch(runId, task.task_id);
  await deps.git.push("origin", branch, {
    setUpstream: true,
    cwd: taskWorktreePath(deps.dataDir, runId, task.task_id)
  });
  const pr = await createTaskPrIdempotent({
    ghClient: deps.gh,
    branch,
    title: specTask.title,
    body: shipBody(runId, specTask),
    base: resolveStagingBranch(runId, ctx.run.staging_branch)
  });
  await deps.state.updateTask(runId, task.task_id, (t) => ({
    ...t,
    branch,
    pr_number: pr.number
  }));
  if (deps.shipMode !== "live") {
    return taskDone();
  }
  const serializer = new MergeSerializer({
    ghClient: deps.gh,
    owner: deps.owner,
    repo: deps.repo,
    stagingBranch: resolveStagingBranch(runId, ctx.run.staging_branch),
    dataDir: deps.dataDir
  });
  const outcome = await serializer.merge(pr.number);
  if (outcome.merged) {
    log27.info(`task '${task.task_id}' merged PR #${pr.number} via ${outcome.via}`);
    return taskDone();
  }
  return waitRetry("ship", `serial merge refused (${outcome.reason})`, 1, 1);
}

// src/driver/coroutine.ts
var log28 = createLogger("coroutine");
var MERGE_RESYNC_CAP = 8;
function requireTask2(run9, taskId) {
  const task = run9.tasks[taskId];
  if (task === void 0) {
    throw new Error(`coroutine: run '${run9.run_id}' has no task '${taskId}'`);
  }
  return task;
}
function terminalOutcome(task) {
  if (task.status === "done") return { outcome: "done" };
  if (task.failure_class === void 0) {
    throw new Error(
      `coroutine: terminal task '${task.task_id}' has no failure_class \u2014 schema invariant violated`
    );
  }
  if (task.failure_reason === void 0) {
    throw new Error(
      `coroutine: terminal task '${task.task_id}' has no failure_reason \u2014 schema invariant violated`
    );
  }
  return {
    outcome: "dropped",
    failure_class: task.failure_class,
    reason: task.failure_reason
  };
}
function asSpawnStage(stage) {
  if (isSpawnStage(stage)) {
    return stage;
  }
  throw new Error(
    `coroutine: stage '${stage}' cannot spawn agents (only tests|exec|verify can) \u2014 unreachable`
  );
}
async function holdoutSidecar(deps, runId, taskId, baseRef) {
  if (!await deps.holdout.has(runId, taskId)) {
    return void 0;
  }
  const record = await deps.holdout.get(runId, taskId);
  const worktree = taskWorktreePath(deps.dataDir, runId, taskId);
  return {
    kind: "holdout-validate",
    task_id: taskId,
    worktree,
    model: resolveReviewModel(deps.config),
    max_turns: deps.config.review.maxTurnsDeep,
    prompt: buildHoldoutPrompt(record, worktree, baseRef)
  };
}
async function foldResults(deps, runId, taskId, stage, task, results) {
  const { fold_key } = results;
  if (!isSpawnStage(stage)) {
    throw new Error(`drive: results given but stage '${stage}' spawns no agents`);
  }
  const spawnStage = stage;
  if (fold_key.stage !== spawnStage || fold_key.rung !== task.escalation_rung) {
    throw new Error(
      `drive: stale or duplicate results (fold_key ${fold_key.stage}/${fold_key.rung} vs cursor ${spawnStage}/${task.escalation_rung}) \u2014 re-invoke without results to get the current envelope`
    );
  }
  const fold = deps;
  if (stage === "tests" || stage === "exec") {
    if (results.producer === void 0) {
      throw new Error(`drive: stage '${stage}' expects producer-status results`);
    }
    const env2 = await applyRecordProducer(
      deps.state,
      runId,
      taskId,
      stage,
      results.producer.status
    );
    return env2.step;
  }
  if (results.reviews === void 0) {
    throw new Error("drive: stage 'verify' expects reviews results");
  }
  if (await deps.holdout.has(runId, taskId) && results.holdout === void 0) {
    throw new Error(
      `drive: task '${taskId}' has a withheld holdout answer key \u2014 verify results must include the holdout-validate raw output (results.holdout is missing)`
    );
  }
  const verdictStore = new FsHoldoutVerdictStore(deps.dataDir);
  if (results.holdout !== void 0) {
    await applyRecordHoldout(fold, runId, taskId, verdictStore, results.holdout.raw);
  }
  const env = await applyRecordReviews(fold, runId, taskId, verdictStore, results.reviews);
  return env.step;
}
async function stepTask(deps, runId, taskId, results) {
  let run9 = await deps.state.read(runId);
  let task = requireTask2(run9, taskId);
  if (isTerminalTaskStatus(task.status)) {
    return { kind: "terminal", run_id: runId, task_id: taskId, outcome: terminalOutcome(task) };
  }
  const stop = await applyQuotaGate(deps, runId, run9.mode);
  if (stop !== null) {
    return {
      kind: "quota-blocked",
      run_id: runId,
      task_id: taskId,
      scope: stop.scope,
      reason: stop.reason,
      ...stop.resets_at_epoch !== void 0 ? { resets_at_epoch: stop.resets_at_epoch } : {}
    };
  }
  let stage = task.stage ?? "preflight";
  let cursorPersisted = false;
  if (results !== void 0) {
    const step = await foldResults(deps, runId, taskId, stage, task, results);
    if (step.done) {
      return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step.outcome };
    }
    stage = step.stage;
    cursorPersisted = true;
  }
  const handlers = makeStageHandlers(deps);
  for (; ; ) {
    run9 = cursorPersisted ? await deps.state.read(runId) : await markInFlight(deps, runId, taskId, stage);
    cursorPersisted = true;
    task = requireTask2(run9, taskId);
    const ctx = { run: run9, task, attempt: task.escalation_rung + 1 };
    const result = stage === "ship" ? await shipTask(deps, ctx) : await runStage(stage, ctx, handlers);
    switch (result.kind) {
      case "advance": {
        stage = result.to;
        cursorPersisted = false;
        continue;
      }
      case "spawn-agents": {
        const spawnStage = asSpawnStage(stage);
        const expects = spawnStage === "verify" ? "reviews" : "producer-status";
        const worktree = taskWorktreePath(deps.dataDir, runId, taskId);
        const base_ref = `origin/${resolveStagingBranch(runId, run9.staging_branch)}`;
        const sidecar = spawnStage === "verify" ? await holdoutSidecar(deps, runId, taskId, base_ref) : void 0;
        const fold_key = { stage: spawnStage, rung: task.escalation_rung };
        return {
          kind: "spawn",
          run_id: runId,
          task_id: taskId,
          stage: spawnStage,
          fold_key,
          manifest: result.manifest,
          ...sidecar !== void 0 ? { sidecar } : {},
          expects,
          worktree,
          base_ref
        };
      }
      case "task-terminal": {
        if (result.outcome.outcome === "done") {
          const step2 = await completeTask(deps, runId, taskId);
          if (!step2.done) throw new Error("coroutine: completeTask returned non-terminal step");
          return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step2.outcome };
        }
        const step = await dropStep(
          deps,
          runId,
          taskId,
          result.outcome.failure_class,
          result.outcome.reason
        );
        if (!step.done) throw new Error("coroutine: dropStep returned non-terminal step");
        return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step.outcome };
      }
      case "wait-retry": {
        if (result.stage === "ship") {
          let newResyncs = 0;
          let overCap = false;
          await deps.state.updateTask(runId, taskId, (t) => {
            newResyncs = t.merge_resyncs + 1;
            overCap = newResyncs > MERGE_RESYNC_CAP;
            if (overCap) return { ...t, merge_resyncs: newResyncs };
            return {
              ...t,
              merge_resyncs: newResyncs,
              stage: "exec",
              status: stageToInFlightStatus("exec")
            };
          });
          if (overCap) {
            const step2 = await dropStep(
              deps,
              runId,
              taskId,
              "blocked-environmental",
              `serial-merge re-sync budget (${MERGE_RESYNC_CAP}) exhausted: ${result.reason}`
            );
            if (!step2.done) throw new Error("coroutine: dropStep returned non-terminal step");
            return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step2.outcome };
          }
          log28.info(
            `task '${taskId}' merge refused (${result.reason}); re-routing to exec to re-sync (attempt ${newResyncs}/${MERGE_RESYNC_CAP})`
          );
          stage = "exec";
          cursorPersisted = true;
          continue;
        }
        const step = await escalateOrDrop(
          deps,
          runId,
          taskId,
          classifyFailure({ kind: "floor-blocked", reason: result.reason }),
          "exec"
        );
        if (step.done) {
          return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step.outcome };
        }
        stage = step.stage;
        cursorPersisted = false;
        continue;
      }
      case "graceful-stop":
      case "finalize-terminal":
        throw new Error(`coroutine: run-scope result '${result.kind}' surfaced at task scope`);
      default:
        return assertNever(result);
    }
  }
}

// src/driver/next.ts
function depsSatisfied(run9, task) {
  return task.depends_on.every((d) => run9.tasks[d]?.status === "done");
}
function isUnsatisfiableDep(run9, depId) {
  const dep = run9.tasks[depId];
  return dep === void 0 || dep.status === "dropped";
}
async function stepRun(deps, runId) {
  let run9 = await deps.state.read(runId);
  const ctx = () => ({ run_id: runId, data_dir: deps.dataDir, ship_mode: run9.ship_mode });
  if (isTerminalRunStatus(run9.status)) {
    return { ...ctx(), kind: "run-terminal", run_status: run9.status };
  }
  if (Object.values(run9.tasks).every((t) => isTerminalTaskStatus(t.status))) {
    return { ...ctx(), kind: "all-terminal", cascade_dropped: [] };
  }
  const stop = await applyQuotaGate(deps, runId, run9.mode);
  if (stop !== null) {
    return {
      ...ctx(),
      kind: "quota-blocked",
      scope: stop.scope,
      reason: stop.reason,
      ...stop.resets_at_epoch !== void 0 ? { resets_at_epoch: stop.resets_at_epoch } : {}
    };
  }
  if (run9.status === "paused" || run9.status === "suspended") {
    const patch = clearCheckpoint();
    run9 = await deps.state.update(runId, (s) => ({
      ...s,
      status: patch.status,
      quota: patch.quota
    }));
  }
  const cascadeDropped = [];
  for (; ; ) {
    run9 = await deps.state.read(runId);
    const blocked = Object.values(run9.tasks).filter(
      (t) => t.status === "pending" && t.depends_on.some((d) => isUnsatisfiableDep(run9, d))
    );
    if (blocked.length === 0) break;
    for (const t of blocked) {
      const unsatisfied = t.depends_on.find((d) => isUnsatisfiableDep(run9, d));
      if (unsatisfied === void 0) {
        throw new Error(
          `next: task '${t.task_id}' classified blocked but no unsatisfiable dep found \u2014 unreachable`
        );
      }
      await dropTask(
        deps,
        runId,
        t.task_id,
        "blocked-environmental",
        `dependency '${unsatisfied}' did not complete (dropped or missing)`
      );
      cascadeDropped.push(t.task_id);
    }
  }
  const tasks = Object.values(run9.tasks);
  if (tasks.every((t) => isTerminalTaskStatus(t.status))) {
    return { ...ctx(), kind: "all-terminal", cascade_dropped: cascadeDropped };
  }
  const ready = tasks.filter((t) => !isTerminalTaskStatus(t.status) && depsSatisfied(run9, t));
  const inFlight = ready.filter((t) => t.status !== "pending").map((t) => t.task_id);
  const pending = ready.filter((t) => t.status === "pending").map((t) => t.task_id);
  const ordered = [...inFlight, ...pending];
  if (ordered.length === 0) {
    const wedged = tasks.filter((t) => !isTerminalTaskStatus(t.status));
    const detail = wedged.map((t) => `${t.task_id}=${t.status}`).join(", ");
    for (const t of wedged) {
      await dropTask(
        deps,
        runId,
        t.task_id,
        "spec-defect",
        `unrunnable: no ready task and no satisfiable path (dependency cycle/deadlock) \u2014 wedged set [${detail}]`
      );
      cascadeDropped.push(t.task_id);
    }
    run9 = await deps.state.read(runId);
    return { ...ctx(), kind: "all-terminal", cascade_dropped: cascadeDropped };
  }
  return { ...ctx(), kind: "tasks-ready", ready: ordered, cascade_dropped: cascadeDropped };
}

// src/cli/wiring.ts
function splitRepo(slug) {
  if (!isValidRepoSlug(slug)) {
    throw new Error(
      `wiring: run spec repo must be '<owner>/<name>' ([A-Za-z0-9._-], not '.'/'..'), got '${slug}'`
    );
  }
  const parts = slug.split("/");
  return { owner: parts[0], repo: parts[1] };
}
async function loadCoroutineDeps(opts) {
  const deps = await loadCliDeps(opts);
  return {
    ...deps,
    usage: new StatuslineUsageSignal({ dataDir: deps.dataDir }),
    now: nowEpoch
  };
}
async function loadCliDeps(opts) {
  const dataDir = resolveDataDir(opts);
  const dirOpts = { ...opts, dataDir };
  const config = loadConfig(dirOpts);
  const state = new StateManager({ ...dirOpts });
  const run9 = await state.read(opts.runId);
  const spec = await new SpecStore(dirOpts).read(run9.spec.repo, run9.spec.spec_id);
  const { owner, repo } = splitRepo(run9.spec.repo);
  return {
    config,
    spec,
    git: new DefaultGitClient(),
    gh: new DefaultGhClient(),
    tools: defaultGateTools(),
    artifacts: new FsArtifactStore(dataDir),
    holdout: new FsHoldoutStore(dataDir),
    dataDir,
    owner,
    repo,
    // The explicit `--ship-mode` flag overrides; otherwise honor the value
    // persisted on the run at create (manual/resume `drive`/`finalize` omit the
    // flag, and a `ship_mode: "live"` run must not silently downgrade to no-merge).
    shipMode: opts.shipMode ?? run9.ship_mode,
    state,
    run: run9
  };
}

// src/autonomy/mode.ts
function isAutonomous(env = process.env) {
  return env.FACTORY_AUTONOMOUS_MODE === "1";
}
var NotAutonomousError = class extends Error {
  constructor() {
    super(
      "Pipeline halted: not running in autonomous mode (FACTORY_AUTONOMOUS_MODE is unset).\nThe factory runs unattended and refuses to start or resume a run otherwise.\nRun `factory autonomy ensure`, then relaunch the session with:\n  claude --settings <merged-settings.json>\nCheck the current state any time with `factory autonomy status`."
    );
    this.name = "NotAutonomousError";
  }
};
function requireAutonomousMode(env = process.env) {
  if (!isAutonomous(env)) throw new NotAutonomousError();
}
function decideAutonomyPreflight(input) {
  const { autonomous, mergedSettingsPresent, pluginVersion, onDiskVersion } = input;
  if (!autonomous) {
    return {
      proceed: false,
      regenerate: true,
      reason: mergedSettingsPresent ? "not-autonomous" : "missing-settings"
    };
  }
  if (!mergedSettingsPresent) {
    return { proceed: true, regenerate: false, reason: "ci-raw-env" };
  }
  if (pluginVersion === void 0) {
    return { proceed: true, regenerate: false, reason: "version-unknowable" };
  }
  if (onDiskVersion === void 0) {
    return { proceed: false, regenerate: true, reason: "unstamped" };
  }
  if (onDiskVersion !== pluginVersion) {
    return { proceed: false, regenerate: true, reason: "stale-version" };
  }
  return { proceed: true, regenerate: false, reason: "fresh" };
}

// src/cli/subcommands/run.ts
var log29 = createLogger("run");
var RUN_HELP = `factory run \u2014 create or resume a run

Usage:
  factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>]
  factory run resume [--run <id>]
  factory run finalize [--run <id>] [--no-ship]
  factory run cancel [--run <id>] [--cleanup] [--session-id <id>]

Actions:
  create     Resolve a durable spec, create a run, seed its tasks, emit the RunState.
  resume     Re-check the live quota window; clear the checkpoint if it has recovered.
  finalize   Build the run report, file per-drop issues, ship the rollup only when completed, flip terminal.
  cancel     Abandon a live run (mark it failed) so the owning session can stop; --cleanup also tears down its branch.`;
var CREATE_HELP = `factory run create \u2014 create a run and seed its tasks from a durable spec

Usage:
  factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>] [--new | --supersede | --resume] [--workflow] [--no-ship] [--session-id <id>]

  --repo        OPTIONAL. Repo identity 'owner/name' (the first key of the spec store).
                Auto-derived from the 'origin' remote when omitted; an explicit value
                that disagrees with the remote fails loud.
  --issue       PRD issue number \u2014 the STABLE lookup key (reruns reuse the spec).
  --spec-id     Explicit '<issue>-<slug>' spec id (alternative to --issue).
  --run-id      Override the generated 'run-YYYYMMDD-HHMMSS' id (determinism/tests).
                A named id is an address: it forces a fresh imperative create.
  --new         Force a fresh run even if a live one already exists for this spec.
  --supersede   Terminate the active run for this spec, then create a fresh one.
  --resume      Continue the active run for this spec (full hand-off: forthcoming).
  --workflow    Run the parallel background Workflow driver. Default (no flag): session \u2014
                the in-session, quota-paced orchestrator loop.
  --no-ship     Open the rollup PR but never merge. Default (no flag): live \u2014 auto-merge
                each task into staging and merge the staging\u2192develop rollup into develop.
                Persisted on the run so the workflow driver + resume + finalize read it
                without re-passing.
  --session-id  Owning Claude Code session id for the session-scoped Stop gate (Prompt J).
                Defaults to $CLAUDE_CODE_SESSION_ID; absent \u21D2 owner-unknown (Stop gate unscoped).

Resolves the spec via the durable store (LOUD if none exists \u2014 generate one first).
On an ACTIVE run for this (repo, spec_id): exits CONFLICT (3) and reports it \u2014 pass
--resume to continue it or --supersede to replace it; --new (or an explicit --run-id)
forces a fresh run regardless. Seeds one pending task per spec task and emits the
RunState JSON (run_id is the top-level field).`;
var RESUME_HELP = `factory run resume \u2014 re-check quota and resume a paused/suspended run

Usage:
  factory run resume [--run <id>]

  --run   The run to resume (defaults to runs/current).

Emits ONE JSON envelope:
  { kind:"resumed", run }                              \u2014 window recovered (or already running)
  { kind:"still-blocked", run_id, status, reason, \u2026 }  \u2014 window has not recovered (state untouched)

A terminal run is a loud error (nothing to resume).`;
var FINALIZE_HELP = `factory run finalize \u2014 turn an all-terminal run into its shipped outcome

Usage:
  factory run finalize [--run <id>] [--no-ship]

  --run       The run to finalize (defaults to runs/current).
  --no-ship   Open the rollup PR but never merge it \u2014 overrides the run's persisted ship
              mode for THIS finalize only. Default: honor the persisted ship_mode (live
              merges the staging\u2192develop rollup; no-merge opens it only).

Builds the deterministic partial-run report (report.md), emits run.finalized
telemetry, files ONE GitHub issue per dropped task (deduped), opens + CI-gates +
(when shipping live) squash-merges the staging\u2192develop rollup, then flips the run
terminal \u2014 in that resume-safe order. LOUD if any task is still non-terminal.

Emits ONE JSON envelope:
  { kind:"finalized", run, report, rollup?, issues_filed }`;
var CANCEL_HELP = `factory run cancel \u2014 abandon a live run (mark it failed) so the session can stop

Usage:
  factory run cancel [--run <id>] [--cleanup] [--session-id <id>]

  --run         The run to cancel. Default: the active run THIS session owns
                (--session-id / $CLAUDE_CODE_SESSION_ID), else runs/current.
  --cleanup     Also tear down the run's staging branch + task PRs (like --supersede).
                Default: leave them in place for manual handling.
  --session-id  Owning session id used to locate the run when --run is omitted
                (defaults to $CLAUDE_CODE_SESSION_ID).

The in-session escape from the Stop gate: marks the run 'failed' via the one sanctioned
state writer \u2014 works even with a task still executing (no rollup CI, no ship), so the gate
stops blocking the owning session. Idempotent; a run already terminal as completed/superseded
is a LOUD error. NOT resumable (cancelled is terminal) \u2014 start a fresh run instead.

Emits ONE JSON envelope:
  { kind:"cancelled", run, cleaned_up }`;
function seedTasksFromSpec(manifest) {
  const ids = new Set(manifest.tasks.map((t) => t.task_id));
  const tasks = {};
  for (const t of manifest.tasks) {
    validateId(t.task_id, "task-id");
    if (tasks[t.task_id] !== void 0) {
      throw new Error(`run create: duplicate task id '${t.task_id}' in spec ${manifest.spec_id}`);
    }
    for (const dep of t.depends_on) {
      if (dep === t.task_id) {
        throw new Error(
          `run create: task '${t.task_id}' depends on itself in spec ${manifest.spec_id}`
        );
      }
      if (!ids.has(dep)) {
        throw new Error(
          `run create: task '${t.task_id}' depends on unknown task '${dep}' in spec ${manifest.spec_id}`
        );
      }
    }
    tasks[t.task_id] = {
      task_id: t.task_id,
      status: "pending",
      depends_on: [...t.depends_on],
      risk_tier: t.risk_tier,
      escalation_rung: 0,
      reviewers: [],
      merge_resyncs: 0
    };
  }
  assertAcyclic(tasks, manifest.spec_id);
  return tasks;
}
function assertAcyclic(tasks, specId) {
  const VISITING = 1;
  const DONE = 2;
  const state = /* @__PURE__ */ new Map();
  const visit = (id, trail) => {
    const mark = state.get(id);
    if (mark === DONE) return;
    if (mark === VISITING) {
      throw new Error(
        `run create: dependency cycle in spec ${specId}: ${[...trail, id].join(" \u2192 ")}`
      );
    }
    state.set(id, VISITING);
    for (const dep of tasks[id]?.depends_on ?? []) {
      visit(dep, [...trail, id]);
    }
    state.set(id, DONE);
  };
  for (const id of Object.keys(tasks)) visit(id, []);
}
async function resolveSpec(specStore, opts) {
  if (opts.specId !== void 0) {
    return specStore.read(opts.repo, opts.specId);
  }
  const resolved = await specStore.resolveByIssue(opts.repo, opts.issue);
  if (resolved === null) {
    throw new Error(
      `run create: no spec for issue #${opts.issue} in ${opts.repo} \u2014 generate one first`
    );
  }
  return resolved;
}
async function createRunFromManifest(state, specStore, manifest, opts, stagingDeps) {
  if (opts.mode === "workflow") {
    log29.warn(
      "workflow mode: quota pacing disabled \u2014 relying on hard rate-limit errors; long runs may exhaust limits"
    );
  }
  const seeded = seedTasksFromSpec(manifest);
  const branch = runStagingBranch(opts.runId);
  await state.create({
    run_id: opts.runId,
    spec: specStore.toPointer(manifest),
    staging_branch: branch,
    // v1 coroutine seam drives tasks strictly one at a time — the driver dial is fixed.
    driver: "sequential",
    ...opts.mode !== void 0 ? { mode: opts.mode } : {},
    ...opts.shipMode !== void 0 ? { ship_mode: opts.shipMode } : {},
    ...opts.ownerSession !== void 0 ? { owner_session: opts.ownerSession } : {}
  });
  const run9 = await state.update(opts.runId, (s) => ({ ...s, tasks: seeded }));
  if (stagingDeps !== void 0) {
    await ensureStaging({
      gitClient: stagingDeps.gitClient,
      stagingBranch: branch,
      baseBranch: stagingDeps.config.git.baseBranch,
      cwd: stagingDeps.targetRoot
    });
    await provisionProtection({
      ghClient: stagingDeps.ghClient,
      owner: stagingDeps.owner,
      repo: stagingDeps.repo,
      branch,
      requiredChecks: stagingDeps.config.git.requiredStatusChecks,
      provision: true
    });
  }
  return run9;
}
async function supersedeRun(state, existing, stagingDeps) {
  const branch = resolveStagingBranch(existing.run_id, existing.staging_branch);
  await stagingDeps.ghClient.deleteProtection(stagingDeps.owner, stagingDeps.repo, branch);
  await stagingDeps.ghClient.deleteRemoteBranch(stagingDeps.owner, stagingDeps.repo, branch);
  await state.finalize(existing.run_id, "superseded");
}
async function resolveOrCreateRun(state, specStore, opts, stagingDeps) {
  const manifest = await resolveSpec(specStore, opts);
  if (opts.intent === "fresh") {
    return {
      kind: "created",
      run: await createRunFromManifest(state, specStore, manifest, opts, stagingDeps)
    };
  }
  const pointer = specStore.toPointer(manifest);
  return state.withSpecLock(pointer.repo, pointer.spec_id, async () => {
    const existing = await state.findActiveBySpec(pointer.repo, pointer.spec_id);
    if (existing !== null) {
      if (opts.intent === "supersede") {
        if (stagingDeps === void 0) {
          throw new UsageError("run create --supersede requires the CLI gh deps");
        }
        const supersededId = existing.run_id;
        await supersedeRun(state, existing, stagingDeps);
        return {
          kind: "superseded",
          run: await createRunFromManifest(state, specStore, manifest, opts, stagingDeps),
          supersededId
        };
      }
      return { kind: "exists", existing };
    }
    return {
      kind: "created",
      run: await createRunFromManifest(state, specStore, manifest, opts, stagingDeps)
    };
  });
}
async function applyResume(state, runId, reading, config, nowEpochSec) {
  const run9 = await state.read(runId);
  if (isTerminalRunStatus(run9.status)) {
    throw new Error(`run resume: run '${runId}' is terminal (${run9.status}); nothing to resume`);
  }
  const plan = planResume(run9, reading, config, nowEpochSec);
  switch (plan.kind) {
    case "not-resumable":
      return { kind: "resumed", run: run9 };
    case "resume": {
      const updated = await state.update(runId, (s) => ({
        ...s,
        status: plan.clear.status,
        quota: plan.clear.quota
      }));
      return { kind: "resumed", run: updated };
    }
    case "still-blocked": {
      const d = plan.decision;
      if (d.kind === "proceed") {
        return { kind: "resumed", run: run9 };
      }
      const base = {
        kind: "still-blocked",
        run_id: runId,
        status: run9.status,
        reason: d.reason
      };
      return "resetsAtEpoch" in d ? { ...base, resets_at_epoch: d.resetsAtEpoch } : base;
    }
  }
}
function parseIssue(raw) {
  if (raw === void 0) return void 0;
  if (typeof raw !== "string") throw new UsageError("--issue requires a value");
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--issue must be a positive integer, got '${raw}'`);
  }
  return n;
}
function resolveOwnerSession(flag, env = process.env) {
  return optionalString(flag) ?? optionalString(env.CLAUDE_CODE_SESSION_ID);
}
async function runCreate(argv, overrides = {}) {
  const args = parseArgs(argv, { booleans: ["new", "workflow", "no-ship", "supersede", "resume"] });
  if (args.flag("help") === true) {
    emitLine(CREATE_HELP);
    return EXIT.OK;
  }
  requireAutonomousMode();
  const cwd = overrides.cwd ?? process.cwd();
  const gitClient = overrides.gitClient ?? new DefaultGitClient();
  const repoSlug = await resolveRepo({
    explicit: optionalString(args.flag("repo")),
    cwd,
    gitClient
  });
  const issue = parseIssue(args.flag("issue"));
  const specId = optionalString(args.flag("spec-id"));
  let selector;
  if (issue !== void 0 && specId !== void 0) {
    throw new UsageError("run create: pass exactly one of --issue or --spec-id");
  } else if (issue !== void 0) {
    selector = { issue };
  } else if (specId !== void 0) {
    selector = { specId };
  } else {
    throw new UsageError("run create requires --issue <n> or --spec-id <id>");
  }
  const explicitRunId = optionalString(args.flag("run-id"));
  const runId = explicitRunId ?? makeRunId();
  validateId(runId, "run-id");
  const mode = args.flag("workflow") === true ? "workflow" : "session";
  const shipMode = args.flag("no-ship") === true ? "no-merge" : "live";
  const ownerSession = resolveOwnerSession(args.flag("session-id"));
  const fresh = args.flag("new") === true || explicitRunId !== void 0;
  const supersede = args.flag("supersede") === true;
  const resume = args.flag("resume") === true;
  if (resume && (args.flag("workflow") === true || args.flag("no-ship") === true)) {
    throw new UsageError(
      "run create: --workflow/--no-ship are create-only and cannot combine with --resume \u2014 a resumed run keeps the mode/ship_mode it was created with. Drop the flag to continue the existing run, or use --supersede to start fresh in that mode."
    );
  }
  const picked = [supersede && "supersede", resume && "resume", fresh && "fresh"].filter(
    Boolean
  );
  if (picked.length > 1) {
    throw new UsageError("run create: pass at most one of --new / --supersede / --resume");
  }
  const intent = picked[0] ?? "default";
  const dataDir = resolveDataDir(
    overrides.dataDir !== void 0 ? { dataDir: overrides.dataDir } : {}
  );
  const config = loadConfig(overrides.dataDir !== void 0 ? { dataDir } : {});
  const state = new StateManager({ dataDir });
  const specStore = new SpecStore({ dataDir });
  const ghClient = overrides.ghClient ?? new DefaultGhClient();
  const { owner, repo } = splitRepoSlug(repoSlug);
  const stagingDeps = {
    gitClient,
    ghClient,
    config,
    targetRoot: cwd,
    owner,
    repo
  };
  const result = await resolveOrCreateRun(
    state,
    specStore,
    {
      repo: repoSlug,
      runId,
      ...selector,
      mode,
      shipMode,
      ...ownerSession !== void 0 ? { ownerSession } : {},
      intent
    },
    stagingDeps
  );
  if (result.kind === "exists") {
    emitJson({
      kind: "exists",
      existing: { run_id: result.existing.run_id, status: result.existing.status }
    });
    emitError(
      `run create: active run '${result.existing.run_id}' already exists \u2014 pass --resume to continue it or --supersede to replace it`
    );
    return EXIT.CONFLICT;
  }
  if (result.kind === "created") {
    emitJson({ kind: "created", run: result.run });
    return EXIT.OK;
  }
  emitJson({ kind: "superseded", run: result.run, supersededId: result.supersededId });
  return EXIT.OK;
}
async function runResume(argv) {
  const args = parseArgs(argv, { booleans: ["workflow", "no-ship"] });
  if (args.flag("help") === true) {
    emitLine(RESUME_HELP);
    return EXIT.OK;
  }
  if (args.flag("workflow") === true || args.flag("no-ship") === true) {
    throw new UsageError(
      "run resume: --workflow/--no-ship are not valid on resume \u2014 a run keeps the mode/ship_mode it was created with. Resume drives the run in its persisted mode."
    );
  }
  requireAutonomousMode();
  const dataDir = resolveDataDir({});
  const config = loadConfig({ dataDir });
  const state = new StateManager({ dataDir });
  const runId = await resolveRunId(state, args, "resume");
  const reading = await new StatuslineUsageSignal({ dataDir }).read();
  const envelope = await applyResume(state, runId, reading, config, nowEpoch());
  emitJson(envelope);
  return EXIT.OK;
}
async function resolveRunId(state, args, action, overrides = {}) {
  const explicit = optionalString(args.flag("run"));
  if (explicit !== void 0) return explicit;
  const current = await readCurrentForCwd(state, overrides);
  if (current === null) {
    throw new UsageError(`run ${action}: no --run given and no current run`);
  }
  return current.run_id;
}
async function runFinalize(argv) {
  const args = parseArgs(argv, { booleans: ["no-ship"] });
  if (args.flag("help") === true) {
    emitLine(FINALIZE_HELP);
    return EXIT.OK;
  }
  const shipMode = args.flag("no-ship") === true ? "no-merge" : void 0;
  const dataDir = resolveDataDir({});
  const state = new StateManager({ dataDir });
  const runId = await resolveRunId(state, args, "finalize");
  const deps = await loadCliDeps({
    dataDir,
    runId,
    ...shipMode !== void 0 ? { shipMode } : {}
  });
  const { run: run9, report, rollup: rollup2, issuesFiled } = await finalizeRun(deps, runId);
  emitJson({
    kind: "finalized",
    run: run9,
    report,
    ...rollup2 !== void 0 ? { rollup: rollup2 } : {},
    issues_filed: issuesFiled
  });
  return EXIT.OK;
}
async function resolveCancelRunId(state, args, sessionId, overrides = {}) {
  const explicit = optionalString(args.flag("run"));
  if (explicit !== void 0) return explicit;
  if (sessionId !== void 0) {
    const owned = await state.findAllActiveByOwner(sessionId);
    if (owned.length === 1) return owned[0].run_id;
    if (owned.length >= 2) {
      const ids = owned.map((r) => r.run_id).join(", ");
      throw new UsageError(
        `run cancel: session '${sessionId}' owns ${owned.length} live runs (${ids}); pass --run <id> to choose which to cancel`
      );
    }
  }
  const current = await readCurrentForCwd(state, overrides);
  if (current === null) {
    throw new UsageError("run cancel: no --run given and no owned/current run to cancel");
  }
  return current.run_id;
}
async function runCancel(argv, overrides = {}) {
  const args = parseArgs(argv, { booleans: ["cleanup"] });
  if (args.flag("help") === true) {
    emitLine(CANCEL_HELP);
    return EXIT.OK;
  }
  const dataDir = resolveDataDir(
    overrides.dataDir !== void 0 ? { dataDir: overrides.dataDir } : {}
  );
  const state = new StateManager({ dataDir });
  const sessionId = resolveOwnerSession(args.flag("session-id"));
  const currentOverrides = {
    ...overrides.gitClient !== void 0 ? { gitClient: overrides.gitClient } : {},
    ...overrides.cwd !== void 0 ? { cwd: overrides.cwd } : {}
  };
  const runId = await resolveCancelRunId(state, args, sessionId, currentOverrides);
  const run9 = await state.finalize(runId, "failed");
  const cleanup = args.flag("cleanup") === true;
  const branch = resolveStagingBranch(run9.run_id, run9.staging_branch);
  let cleanedUp = false;
  let cleanupError;
  if (cleanup) {
    const ghClient = overrides.ghClient ?? new DefaultGhClient();
    const { owner, repo } = splitRepoSlug(run9.spec.repo);
    try {
      await ghClient.deleteProtection(owner, repo, branch);
      await ghClient.deleteRemoteBranch(owner, repo, branch);
      cleanedUp = true;
    } catch (err) {
      cleanupError = err instanceof Error ? err.message : String(err);
    }
  }
  emitJson({
    kind: "cancelled",
    run: run9,
    cleaned_up: cleanedUp,
    ...cleanupError !== void 0 ? { cleanup_error: cleanupError } : {}
  });
  if (cleanupError !== void 0) {
    emitError(
      `run ${run9.run_id} cancelled (marked failed), but --cleanup did NOT finish for staging branch '${branch}': ${cleanupError}. The branch may still exist \u2014 re-run \`factory run cancel --run ${run9.run_id} --cleanup\` to retry the teardown.`
    );
  } else {
    emitError(
      `run ${run9.run_id} cancelled (marked failed)` + (cleanup ? `; staging branch '${branch}' + its task PRs torn down.` : `; staging branch '${branch}' left in place \u2014 delete it manually or re-run with --cleanup.`)
    );
  }
  return EXIT.OK;
}
async function run3(argv) {
  const action = argv[0];
  if (action === void 0 || action === "--help" || action === "-h") {
    emitLine(RUN_HELP);
    return EXIT.OK;
  }
  const rest = argv.slice(1);
  switch (action) {
    case "create":
      return runCreate(rest);
    case "resume":
      return runResume(rest);
    case "finalize":
      return runFinalize(rest);
    case "cancel":
      return runCancel(rest);
    default:
      throw new UsageError(
        `unknown run action '${action}' (expected create | resume | finalize | cancel)`
      );
  }
}
var runCommand = {
  describe: "Create or resume a run (create resolves+seeds a spec; resume re-checks quota)",
  run: async (argv) => {
    try {
      return await run3(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`run: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};
var resumeCommand = {
  describe: "Resume a paused/suspended run (re-check quota; clear a recovered checkpoint)",
  run: async (argv) => {
    try {
      return await runResume(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`resume: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

// src/cli/subcommands/spec.ts
import { join as join15 } from "node:path";
var SPEC_HELP = `factory spec \u2014 deterministic spec-build seam (resolve \u2192 gate \u2192 store)

Usage:
  factory spec resolve [--repo <owner/name>] --issue <n>
  factory spec gate    [--repo <owner/name>] --issue <n>
  factory spec store   [--repo <owner/name>] --issue <n>

--repo is OPTIONAL: auto-derived from the 'origin' remote when omitted; an explicit
value that disagrees with the remote fails loud.

The in-session orchestrator drives the agent spawns + the bounded regen loop; each
action emits ONE JSON envelope naming the next step. Scratch JSON is threaded
through <dataDir>/spec-build/<repo>/<issue>/{prd,generated,verdict}.json.

Actions:
  resolve  Reuse an existing spec by issue, else fetch the PRD + emit the generate spawn.
  gate     Run the deterministic spec gates; emit revise (blockers) or the review spawn.
  store    Adjudicate the review (56/60 + floor); emit revise or persist + emit the pointer.`;
var PRD_FILE = "prd.json";
var GENERATED_FILE = "generated.json";
var VERDICT_FILE = "verdict.json";
function scratchPaths(dataDir, repo, issue) {
  const dir = specBuildDir(dataDir, repo, issue);
  return {
    prdPath: join15(dir, PRD_FILE),
    generatedPath: join15(dir, GENERATED_FILE),
    verdictPath: join15(dir, VERDICT_FILE)
  };
}
async function resolveSpec2(deps, repo, issue) {
  const existing = await deps.store.resolveByIssue(repo, issue);
  if (existing) {
    return { kind: "reuse", repo, issue, pointer: deps.store.toPointer(existing) };
  }
  const prd = await deps.gh.fetchPrd(issue, { repo });
  const { prdPath, generatedPath } = scratchPaths(deps.dataDir, repo, issue);
  await atomicWriteFile(prdPath, stringifyJson(prd));
  return {
    kind: "generate",
    repo,
    issue,
    spawn: buildGenerateSpawn(prd),
    prd_path: prdPath,
    generated_path: generatedPath,
    max_iterations: deps.config.spec.maxRegenIterations
  };
}
async function gateSpec(deps, repo, issue) {
  const { prdPath, generatedPath, verdictPath } = scratchPaths(deps.dataDir, repo, issue);
  const prd = await readJsonInput(prdPath);
  const generated = parseGenerateResult(await readJsonInput(generatedPath));
  const gates = runSpecGates(prd, generated.tasks);
  if (!gates.passed) {
    return {
      kind: "revise",
      repo,
      issue,
      source: "gate",
      reason: "deterministic spec gates blocked the spec",
      blockers: gates.blockers,
      generated_path: generatedPath
    };
  }
  return {
    kind: "review",
    repo,
    issue,
    spawn: buildReviewSpawn(prd, generated),
    generated_path: generatedPath,
    verdict_path: verdictPath
  };
}
async function storeSpec(deps, repo, issue) {
  const { generatedPath, verdictPath } = scratchPaths(deps.dataDir, repo, issue);
  const generated = parseGenerateResult(await readJsonInput(generatedPath));
  const verdict = parseReviewVerdict(await readJsonInput(verdictPath));
  const decision = decideSpecReview(verdict, {
    passReviewThreshold: deps.config.spec.passReviewThreshold,
    dimensionFloor: deps.config.spec.dimensionFloor
  });
  if (decision.decision === "NEEDS_REVISION") {
    return {
      kind: "revise",
      repo,
      issue,
      source: "review",
      reason: decision.reason,
      blockers: verdict.blockers.length > 0 ? verdict.blockers : [decision.reason],
      generated_path: generatedPath
    };
  }
  const manifest = buildManifest(repo, issue, generated);
  const pointer = await deps.store.write(manifest, generated.specMd);
  return { kind: "stored", repo, issue, pointer };
}
function parseIssue2(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--issue must be a positive integer, got '${raw}'`);
  }
  return n;
}
function wireDeps() {
  const dataDir = resolveDataDir({});
  const config = loadConfig({ dataDir });
  return {
    store: new SpecStore({ dataDir }),
    gh: new RealGhClient({ bodyMaxBytes: config.spec.prdBodyMaxBytes }),
    config,
    dataDir
  };
}
var ACTIONS = {
  resolve: resolveSpec2,
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
async function run4(argv) {
  const action = argv[0];
  if (action === void 0 || action === "--help" || action === "-h") {
    emitLine(SPEC_HELP);
    return EXIT.OK;
  }
  const handler = ACTIONS[action];
  if (handler === void 0) {
    throw new UsageError(`unknown spec action '${action}' (expected resolve | gate | store)`);
  }
  const args = parseArgs(argv.slice(1));
  if (args.flag("help") === true) {
    emitLine(SPEC_HELP);
    return EXIT.OK;
  }
  const issue = parseIssue2(args.requireFlag("issue"));
  const repo = await resolveSpecRepo(args);
  const envelope = await handler(wireDeps(), repo, issue);
  emitJson(envelope);
  return EXIT.OK;
}
var specCommand = {
  describe: "Build a durable spec (resolve \u2192 gate \u2192 store; orchestrator drives the agent spawns)",
  run: async (argv) => {
    try {
      return await run4(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`spec: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

// src/rescue/scan.ts
function dispositionOf(status, failureClass) {
  if (status === "done") return "shipped";
  if (status === "pending") return "runnable";
  if (status === "dropped") {
    return failureClass === "blocked-environmental" ? "recoverable" : "dead-end";
  }
  return "stuck";
}
function depsSatisfied2(run9, depends) {
  return depends.every((d) => run9.tasks[d]?.status === "done");
}
function hasUnsatisfiableDep(run9, depends) {
  return depends.some((d) => {
    const dep = run9.tasks[d];
    return dep === void 0 || dep.status === "dropped";
  });
}
function scanRun(run9) {
  const all = Object.values(run9.tasks);
  const tasks = all.map((t) => ({
    task_id: t.task_id,
    status: t.status,
    disposition: dispositionOf(t.status, t.failure_class),
    ...t.failure_class !== void 0 ? { failure_class: t.failure_class } : {},
    ...t.failure_reason !== void 0 ? { failure_reason: t.failure_reason } : {},
    ...t.branch !== void 0 ? { branch: t.branch } : {},
    ...t.pr_number !== void 0 ? { pr_number: t.pr_number } : {}
  }));
  const by = (d) => tasks.filter((t) => t.disposition === d);
  const stuck = by("stuck");
  const recoverable = by("recoverable");
  const deadEnd = by("dead-end");
  const resettable = [...stuck, ...recoverable].map((t) => t.task_id);
  const dead_ends = deadEnd.map((t) => t.task_id);
  const allTerminal = all.every((t) => isTerminalTaskStatus(t.status));
  const actionablePending = all.some(
    (t) => t.status === "pending" && (depsSatisfied2(run9, t.depends_on) || hasUnsatisfiableDep(run9, t.depends_on))
  );
  const would_deadlock = !allTerminal && !actionablePending;
  const needs_rescue = resettable.length > 0;
  return {
    run_id: run9.run_id,
    run_status: run9.status,
    counts: {
      total: all.length,
      shipped: by("shipped").length,
      runnable: by("runnable").length,
      stuck: stuck.length,
      recoverable: recoverable.length,
      dead_end: deadEnd.length
    },
    resettable,
    dead_ends,
    needs_rescue,
    would_deadlock,
    summary: summarize2(run9.status, resettable.length, dead_ends.length, would_deadlock),
    tasks
  };
}
function summarize2(status, resettable, deadEnds, wouldDeadlock) {
  if (resettable === 0) {
    const tail = deadEnds > 0 ? ` (${deadEnds} dead-end drop(s) \u2014 need a fix + --include-dead-ends)` : "";
    return `run '${status}': no rescue needed${tail}`;
  }
  const reopen = isTerminalRunStatus(status) ? " (will reopen the run)" : "";
  const deadlock = wouldDeadlock ? "; a re-drive would deadlock without rescue" : "";
  return `run '${status}': rescue can reset ${resettable} task(s)${reopen}${deadlock}`;
}

// src/rescue/apply.ts
function resetTaskRow(task) {
  const {
    failure_class: _failureClass,
    failure_reason: _failureReason,
    producer_role: _producerRole,
    started_at: _startedAt,
    ended_at: _endedAt,
    stage: _stage,
    ...rest
  } = task;
  return {
    ...rest,
    status: "pending",
    escalation_rung: 0,
    reviewers: [],
    merge_resyncs: 0
  };
}
function selectTargets(run9, opts) {
  const explicit = opts.tasks ?? [];
  if (explicit.length > 0) {
    const targets2 = [];
    const skipped = [];
    for (const id of explicit) {
      const task = run9.tasks[id];
      if (task === void 0) {
        throw new Error(`rescue: run '${run9.run_id}' has no task '${id}'`);
      }
      if (task.status === "done") {
        throw new Error(
          `rescue: refusing to reset shipped task '${id}' (status 'done') \u2014 would un-ship merged work`
        );
      }
      if (task.status === "pending") {
        skipped.push(id);
        continue;
      }
      targets2.push(id);
    }
    return { targets: targets2, skipped };
  }
  const scan = scanRun(run9);
  const targets = opts.includeDeadEnds ? [...scan.resettable, ...scan.dead_ends] : [...scan.resettable];
  return { targets, skipped: [] };
}
async function applyRescue(state, runId, opts = {}) {
  let result = null;
  const updated = await state.update(runId, (run9) => {
    const { targets, skipped } = selectTargets(run9, opts);
    const wasTerminal = isTerminalRunStatus(run9.status);
    const reopen = wasTerminal && targets.length > 0;
    result = {
      run_id: runId,
      run_status: reopen ? "running" : run9.status,
      reset: targets,
      reopened: reopen,
      skipped
    };
    if (targets.length === 0 && !reopen) {
      return run9;
    }
    const nextTasks = { ...run9.tasks };
    for (const id of targets) {
      nextTasks[id] = resetTaskRow(run9.tasks[id]);
    }
    return {
      ...run9,
      tasks: nextTasks,
      // Reopen: a terminal run carries no quota checkpoint (finalize cleared it),
      // so returning to `running` with `ended_at:null` satisfies every invariant.
      ...reopen ? { status: "running", ended_at: null } : {}
    };
  });
  return { ...result, run_status: updated.status };
}

// src/cli/subcommands/rescue.ts
var RESCUE_HELP = `factory rescue \u2014 scan or recover a stalled run

Usage:
  factory rescue scan  [--run <id>]
  factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends]

Actions:
  scan    Classify every task (read-only); report what a re-drive would do.
  apply   Reset the resettable tasks to pending; reopen a terminal run.`;
var SCAN_HELP = `factory rescue scan \u2014 classify a stalled run (read-only)

Usage:
  factory rescue scan [--run <id>]

  --run   The run to scan (defaults to runs/current).

Emits ONE JSON document: the RescueScan (counts, resettable, dead_ends,
needs_rescue, would_deadlock, summary, per-task lines). Writes nothing.`;
var APPLY_HELP = `factory rescue apply \u2014 reset resettable tasks and reopen a terminal run

Usage:
  factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends]

  --run                The run to recover (defaults to runs/current).
  --task               Reset exactly this task (repeatable). Overrides the default
                       resettable set; a 'done' task is a loud error, a 'pending'
                       one is skipped. An explicitly-named dead-end IS reset.
  --include-dead-ends  Also reset dead-end drops (spec-defect / capability-budget).
                       Use only after the root cause is actually fixed.

Default (no --task): resets stuck (crashed in-flight) + recoverable
(blocked-environmental) tasks, leaving dead-ends dropped. Reopens a terminal run
to 'running' when it reset work. Idempotent.

Emits ONE JSON document:
  { run_id, run_status, reset:[...], reopened, skipped:[...] }`;
async function resolveRunId2(state, args, action, overrides) {
  const explicit = args.flag("run");
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const current = await readCurrentForCwd(state, overrides);
  if (current === null) {
    throw new UsageError(`rescue ${action}: no --run given and no current run`);
  }
  return current.run_id;
}
async function runScan(argv, overrides = {}) {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(SCAN_HELP);
    return EXIT.OK;
  }
  const state = new StateManager();
  const runId = await resolveRunId2(state, args, "scan", overrides);
  const run9 = await state.read(runId);
  emitJson(scanRun(run9));
  return EXIT.OK;
}
async function runApply(argv, overrides = {}) {
  const args = parseArgs(argv, { booleans: ["include-dead-ends"] });
  if (args.flag("help") === true) {
    emitLine(APPLY_HELP);
    return EXIT.OK;
  }
  const state = new StateManager();
  const runId = await resolveRunId2(state, args, "apply", overrides);
  const tasks = args.all("task");
  const includeDeadEnds = args.flag("include-dead-ends") === true;
  const result = await applyRescue(state, runId, {
    ...tasks.length > 0 ? { tasks } : {},
    includeDeadEnds
  });
  emitJson(result);
  return EXIT.OK;
}
async function run5(argv) {
  const action = argv[0];
  if (action === void 0 || action === "--help" || action === "-h") {
    emitLine(RESCUE_HELP);
    return EXIT.OK;
  }
  const rest = argv.slice(1);
  switch (action) {
    case "scan":
      return runScan(rest);
    case "apply":
      return runApply(rest);
    default:
      throw new UsageError(`unknown rescue action '${action}' (expected scan | apply)`);
  }
}
var rescueCommand = {
  describe: "Scan or recover a stalled run (reset stuck tasks; reopen a terminal run)",
  run: async (argv) => {
    try {
      return await run5(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`rescue: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

// src/cli/subcommands/score.ts
var HELP4 = `factory score \u2014 report a run's outcome summary (read-only)

Usage:
  factory score [--run <id>] [--dead-surface] [--base <ref>] [--project-root <dir>]

  --run            The run to score (defaults to runs/current).
  --dead-surface   Also enumerate unreferenced exports in the run diff (report-only).
  --base           Diff base for --dead-surface (default: origin/<git.baseBranch>).
  --project-root   Repo checkout to scan for --dead-surface (default: cwd).

Emits ONE JSON document:
  { kind:"score", summary, dead_surface? }`;
async function runScore(argv, overrides = {}) {
  const args = parseArgs(argv, { booleans: ["dead-surface"] });
  if (args.flag("help") === true) {
    emitLine(HELP4);
    return EXIT.OK;
  }
  const dataDir = resolveDataDir({});
  const state = new StateManager({ dataDir });
  const explicitRun = optionalString(args.flag("run"));
  const runState2 = explicitRun !== void 0 ? await state.read(explicitRun) : await readCurrentForCwd(state, overrides);
  if (runState2 === null) {
    throw new UsageError("score: no --run given and no current run");
  }
  const specStore = new SpecStore({ dataDir });
  const manifest = await specStore.read(runState2.spec.repo, runState2.spec.spec_id);
  const report = buildPartialReport(runState2, manifest);
  const summary = buildRunSummary(runState2, report);
  let deadSurface;
  if (args.flag("dead-surface") === true) {
    const config = loadConfig({ dataDir });
    const base = optionalString(args.flag("base")) ?? `origin/${config.git.baseBranch}`;
    const cwd = optionalString(args.flag("project-root")) ?? process.cwd();
    deadSurface = await scoreDeadSurface(base, cwd);
  }
  emitJson({
    kind: "score",
    summary,
    ...deadSurface !== void 0 ? { dead_surface: deadSurface } : {}
  });
  return EXIT.OK;
}
async function scoreDeadSurface(base, cwd) {
  let changedFiles;
  try {
    changedFiles = await new DefaultGitProbe().changedFiles(base, { cwd });
  } catch (err) {
    return {
      tool: "ts-prune",
      status: "error",
      changed_file_count: 0,
      total_found: 0,
      findings: [],
      note: `could not resolve the run diff against '${base}': ${err.message}`
    };
  }
  return scanDeadSurface(new TsPruneRunner(), changedFiles, { cwd });
}
var scoreCommand = {
  describe: "Report a run's outcome summary (read-only; optional --dead-surface scan)",
  run: async (argv) => {
    try {
      return await runScore(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`score: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

// src/cli/subcommands/drive.ts
var HELP5 = `factory drive \u2014 step one task until it needs agents or is terminal

Usage:
  factory drive --run <id> --task <id> [--results <file>] [--ship-mode <mode>]

--ship-mode (optional): no-merge | live \u2014 overrides the run's persisted ship_mode for
this step only; omit to honor the persisted value (the seam default, never no-merge).

Emits ONE JSON envelope to stdout:
  { kind:"spawn", run_id, task_id, stage, manifest, sidecar?, expects, fold_key, worktree }
  { kind:"terminal", run_id, task_id, outcome }
  { kind:"quota-blocked", run_id, task_id, scope, reason, resets_at_epoch? }

--results feeds back what the previous spawn envelope asked for. It MUST echo the
envelope's fold_key verbatim; a stale/duplicate key rejects LOUD (re-invoke without
--results to get the current envelope):
  expects=producer-status \u2192 { "fold_key": {\u2026}, "producer": { "status": "<STATUS line>" } }
  expects=reviews         \u2192 { "fold_key": {\u2026}, "holdout"?: {"raw": "<validator output>"},
                              "reviews": { reviews, verifications, crossVendorAbsent? } }
Re-invoking without --results re-derives the same spawn envelope (idempotent).`;
async function run6(argv) {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(HELP5);
    return EXIT.OK;
  }
  const runId = args.requireFlag("run");
  const taskId = args.requireFlag("task");
  const shipMode = parseShipMode(args.flag("ship-mode"));
  const resultsPath = args.flag("results");
  let results;
  if (typeof resultsPath === "string" && resultsPath.length > 0) {
    try {
      results = parseDriveResults(await readJsonInput(resultsPath));
    } catch (err) {
      throw new UsageError(
        `--results ${resultsPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (resultsPath !== void 0) {
    throw new UsageError("--results requires a file path");
  }
  const deps = await loadCoroutineDeps({ runId, ...shipMode !== void 0 ? { shipMode } : {} });
  const envelope = await stepTask(deps, runId, taskId, results);
  emitJson(envelope);
  return EXIT.OK;
}
var driveCommand = {
  describe: "Step one task: run deterministic steps, emit spawn/terminal/quota envelope",
  run: async (argv) => {
    try {
      return await run6(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`drive: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

// src/cli/subcommands/next.ts
var HELP6 = `factory next \u2014 one run-loop step: quota gate, cascade-drop, ready set

Usage:
  factory next [--run <id>]      (defaults to runs/current)

Emits ONE JSON envelope to stdout. Every variant also carries the self-resolved run
context \u2014 run_id, data_dir (canonical), ship_mode \u2014 so the workflow driver
adopts them from the first \`next\` instead of via Workflow args:
  { kind:"tasks-ready", run_id, data_dir, ship_mode, ready:[...], cascade_dropped:[...] }
  { kind:"all-terminal", run_id, data_dir, ship_mode, cascade_dropped:[...] }  \u2192 call \`factory run finalize\`
  { kind:"run-terminal", run_id, data_dir, ship_mode, run_status }
  { kind:"quota-blocked", run_id, data_dir, ship_mode, scope, reason, resets_at_epoch? }

  factory next --assert-owner <session>          (loud-assert runs/current ownership)
  factory next --expect-mode <session|workflow>  (loud-assert runs/current mode)

Ready tasks are ordered in-flight first (crash resume), then pending (spec order).
Throws LOUD on a dependency deadlock.`;
function assertCurrentOwner(current, assertOwner) {
  const expected = typeof assertOwner === "string" ? assertOwner.trim() : "";
  if (expected.length === 0) return;
  const actual = current.owner_session;
  if (actual === void 0) return;
  if (actual !== expected) {
    throw new Error(
      `next: runs/current points at run '${current.run_id}' owned by session '${actual}', but --assert-owner expected '${expected}' \u2014 a concurrent 'run create' moved runs/current onto a foreign run. Relaunch via /factory:run --workflow, or pass --run <id> explicitly.`
    );
  }
}
function assertExpectedMode(current, expectMode) {
  if (expectMode === void 0) return;
  const parsed = RunModeEnum.safeParse(typeof expectMode === "string" ? expectMode : "");
  if (!parsed.success) {
    throw new UsageError(
      `--expect-mode must be ${RunModeEnum.options.map((o) => `'${o}'`).join(" or ")}, got '${String(expectMode)}'`
    );
  }
  if (current.mode !== parsed.data) {
    throw new Error(
      `next: runs/current points at run '${current.run_id}' in mode '${current.mode}', but --expect-mode expected '${parsed.data}' \u2014 a concurrent 'run create' moved runs/current onto a run of a different mode. Relaunch via /factory:run --workflow, or pass --run <id> explicitly.`
    );
  }
}
async function run7(argv) {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(HELP6);
    return EXIT.OK;
  }
  const explicit = args.flag("run");
  let runId;
  if (typeof explicit === "string" && explicit.length > 0) {
    runId = explicit;
  } else {
    const dataDir = resolveDataDir({});
    const current = await new StateManager({ dataDir }).readCurrent();
    if (current === null) throw new UsageError("no --run given and no current run");
    assertCurrentOwner(current, args.flag("assert-owner"));
    assertExpectedMode(current, args.flag("expect-mode"));
    runId = current.run_id;
  }
  const deps = await loadCoroutineDeps({ runId });
  emitJson(await stepRun(deps, runId));
  return EXIT.OK;
}
var nextCommand = {
  describe: "One run-loop step: quota gate, cascade-drop, emit the ready set",
  run: async (argv) => {
    try {
      return await run7(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`next: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

// src/shared/stdin.ts
async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// src/cli/subcommands/statusline.ts
var log30 = createLogger("cli:statusline");
var HELP7 = `factory statusline \u2014 capture Claude Code rate limits + chain the statusline

Wire this as the Claude Code statusLine.command. On every statusline update it
reads the piped JSON payload, writes \`rate_limits + {captured_at}\` to
\${CLAUDE_PLUGIN_DATA}/usage-cache.json (the session-mode quota pacer's input),
and \u2014 if FACTORY_ORIGINAL_STATUSLINE is set \u2014 pipes the same payload to that
command and forwards its stdout as the displayed statusline.

Usage:
  factory statusline        (reads the CC payload from stdin)

This is a side-effecting passthrough, not a machine subcommand: stdout is the
displayed statusline text, NOT a JSON envelope.`;
function rateLimitsOf(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const rl = payload.rate_limits;
  if (typeof rl !== "object" || rl === null) return null;
  return rl;
}
async function writeCache(rateLimits, deps) {
  let dataDir;
  try {
    dataDir = resolveDataDir(deps.dataDirOptions ?? {});
  } catch {
    log30.warn("CLAUDE_PLUGIN_DATA unresolvable; skipping usage-cache.json write");
    return;
  }
  const now = (deps.now ?? nowEpoch)();
  const cache = { ...rateLimits, captured_at: now };
  try {
    await atomicWriteFile(usageCachePath(dataDir), stringifyJson(cache));
  } catch (err) {
    log30.warn(`failed to write usage-cache.json: ${err.message}`);
  }
}
async function passthrough(payload, deps) {
  const original = deps.originalStatusline ?? process.env.FACTORY_ORIGINAL_STATUSLINE ?? "";
  if (original.trim().length === 0) return "";
  try {
    const run9 = deps.exec ?? exec;
    const result = await run9(original, [], { shell: true, input: payload, timeoutMs: 3e3 });
    if (result.code !== 0) {
      const why = result.code === null ? `was killed by signal ${result.signal ?? "unknown"} (likely the 3s timeout)` : `exited ${result.code}`;
      log30.warn(`FACTORY_ORIGINAL_STATUSLINE ${why}; statusline left empty`);
      return "";
    }
    return result.stdout;
  } catch (err) {
    log30.warn(`FACTORY_ORIGINAL_STATUSLINE failed to run: ${err.message}`);
    return "";
  }
}
async function runStatusline(argv = [], deps = {}) {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(HELP7);
    return EXIT.OK;
  }
  const payload = deps.readStdin ? await deps.readStdin() : await readStdin(deps.stdin);
  let parsed;
  try {
    parsed = payload.trim().length > 0 ? JSON.parse(payload) : void 0;
  } catch {
    parsed = void 0;
  }
  const rateLimits = rateLimitsOf(parsed);
  if (rateLimits !== null) {
    await writeCache(rateLimits, deps);
  }
  const displayed = await passthrough(payload, deps);
  const write = deps.writeStdout ?? ((text) => process.stdout.write(text));
  write(displayed);
  return EXIT.OK;
}
var statuslineCommand = {
  describe: "Capture Claude Code rate limits to usage-cache.json + chain the statusline",
  run: (argv) => runStatusline(argv)
};

// src/cli/subcommands/autonomy.ts
import { existsSync as existsSync8 } from "node:fs";
import { readFile as readFile11 } from "node:fs/promises";
import { join as join16 } from "node:path";
import { homedir as homedir3 } from "node:os";
var log31 = createLogger("autonomy");
var HELP8 = `factory autonomy <ensure|status|preflight> \u2014 manage / inspect autonomous mode

The pipeline runs unattended: \`run create\`/\`run resume\` HALT unless the session
is autonomous (FACTORY_AUTONOMOUS_MODE=1). There is no opt-out.

ensure     Merges templates/settings.autonomous.json with your existing settings into
           \${CLAUDE_PLUGIN_DATA}/merged-settings.json (placeholders substituted, env
           baked, statusLine wired to \`factory statusline\`) and prints the relaunch
           command:

             claude --settings <merged-settings.json>

status     Reports whether THIS session is autonomous and whether merged-settings.json
           exists. Exits 0 when autonomous, 1 when not (never throws).

preflight  The run-entry check (what \`/factory:run\` calls). Decides over
           {autonomous?, merged-settings present?, plugin vs on-disk version} whether
           the run may proceed. (Re)scaffolds merged-settings.json and halts for a
           relaunch when the session is not autonomous OR the settings are stale /
           missing / unstamped; proceeds silently when already fresh (or autonomous via
           a directly-exported env). Exits 0 to proceed, 1 to halt. Never throws on the
           decision path.

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
function mergedSettingsPath(dataDir) {
  return join16(dataDir, "merged-settings.json");
}
function tildeExpand(value, home) {
  if (value.startsWith("~")) return home + value.slice(1);
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
  if (!isObject2(sl)) return void 0;
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
  const merged = { ...input.userSettings, ...template };
  const userEnv = isObject2(input.userSettings.env) ? input.userSettings.env : {};
  const templateEnv = isObject2(template.env) ? template.env : {};
  const env = { ...userEnv, ...templateEnv };
  env.CLAUDE_PLUGIN_DATA = dataDir;
  const userPerms = isObject2(input.userSettings.permissions) ? input.userSettings.permissions : {};
  const templatePerms = isObject2(template.permissions) ? template.permissions : {};
  const userAllow = Array.isArray(userPerms.allow) ? userPerms.allow.filter((e) => typeof e === "string") : [];
  const templateAllow = Array.isArray(templatePerms.allow) ? templatePerms.allow.filter((e) => typeof e === "string") : [];
  const unionedAllow = [...userAllow, ...templateAllow.filter((e) => !userAllow.includes(e))];
  merged.permissions = { ...userPerms, ...templatePerms, allow: unionedAllow };
  const ourPath = factoryBinPath(pluginRoot);
  const userStatusLine = statusLineCommandOf(input.userSettings);
  const chained = (() => {
    if (userStatusLine === void 0) return void 0;
    const expanded = tildeExpand(userStatusLine, home);
    const parts = expanded.split(/\s+/);
    const expandedPath = parts[0] ?? expanded;
    const expandedSub = parts[1];
    const isOurs = expandedPath === ourPath && expandedSub === "statusline";
    return isOurs ? void 0 : expanded;
  })();
  if (chained !== void 0) {
    env.FACTORY_ORIGINAL_STATUSLINE = chained;
  } else {
    delete env.FACTORY_ORIGINAL_STATUSLINE;
  }
  merged.env = env;
  if (input.version !== void 0 && input.version.length > 0) {
    merged._factoryVersion = input.version;
  }
  return merged;
}
async function readPluginVersion(pluginRoot) {
  const path3 = join16(pluginRoot, ".claude-plugin", "plugin.json");
  if (!existsSync8(path3)) return void 0;
  try {
    const parsed = JSON.parse(await readFile11(path3, "utf8"));
    if (isObject2(parsed) && typeof parsed.version === "string") return parsed.version;
  } catch {
  }
  return void 0;
}
async function runAutonomyEnsure(opts = {}) {
  const home = opts.home ?? homedir3();
  const dataDir = opts.dataDir ?? resolveDataDir();
  const pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
  const userSettingsPath = opts.userSettingsPath ?? join16(home, ".claude", "settings.json");
  const write = opts.writeStdout ?? ((t) => process.stdout.write(t));
  let userSettings = {};
  if (existsSync8(userSettingsPath)) {
    try {
      const parsed = JSON.parse(await readFile11(userSettingsPath, "utf8"));
      if (isObject2(parsed)) userSettings = parsed;
      else log31.warn(`${userSettingsPath} is not a JSON object; ignoring`);
    } catch (err) {
      log31.warn(`could not parse ${userSettingsPath} (${err.message}); ignoring`);
    }
  }
  const templatePath = join16(pluginRoot, "templates", "settings.autonomous.json");
  const template = await readFile11(templatePath, "utf8");
  const version = await readPluginVersion(pluginRoot);
  const merged = materializeMergedSettings({
    template,
    userSettings,
    dataDir,
    pluginRoot,
    home,
    version
  });
  const path3 = mergedSettingsPath(dataDir);
  await atomicWriteFile(path3, stringifyJson(merged));
  const relaunchCommand = `claude --settings ${path3}`;
  write(
    `Wrote autonomous settings \u2192 ${path3}
Relaunch the session in autonomous mode with:

  ${relaunchCommand}

(the first agent turn refreshes the usage cache \u2192 session-mode quota pacing.)
`
  );
  return { path: path3, relaunchCommand };
}
async function runAutonomyStatus(opts = {}) {
  const env = opts.env ?? process.env;
  const write = opts.writeStdout ?? ((t) => process.stdout.write(t));
  let path3 = "";
  try {
    const dataDir = opts.dataDir ?? resolveDataDir();
    path3 = mergedSettingsPath(dataDir);
  } catch {
  }
  const status = {
    autonomous: isAutonomous(env),
    envSet: env.FACTORY_AUTONOMOUS_MODE !== void 0,
    mergedSettingsPresent: path3.length > 0 && existsSync8(path3),
    mergedSettingsPath: path3
  };
  if (opts.json === true) {
    write(stringifyJson(status) + "\n");
  } else if (status.autonomous) {
    write(
      `autonomous: yes (FACTORY_AUTONOMOUS_MODE=1)
merged-settings: ${status.mergedSettingsPresent ? "present" : "absent"}${path3.length > 0 ? ` at ${path3}` : ""}
`
    );
  } else {
    write(
      `autonomous: NO \u2014 the pipeline will refuse to start or resume a run.
merged-settings: ${status.mergedSettingsPresent ? `present at ${path3}` : "absent"}
` + (status.mergedSettingsPresent ? `Relaunch the session with:
  claude --settings ${path3}
` : `Run \`factory autonomy ensure\` first, then relaunch with the printed command.
`)
    );
  }
  return status.autonomous ? EXIT.OK : EXIT.ERROR;
}
async function readOnDiskVersion(path3) {
  if (!existsSync8(path3)) return void 0;
  try {
    const parsed = JSON.parse(await readFile11(path3, "utf8"));
    if (isObject2(parsed) && typeof parsed._factoryVersion === "string") {
      return parsed._factoryVersion;
    }
  } catch {
  }
  return void 0;
}
function describePreflightReason(reason, pluginVersion, onDiskVersion) {
  switch (reason) {
    case "fresh":
      return `merged settings are current (v${pluginVersion ?? "?"})`;
    case "ci-raw-env":
      return "autonomous via the environment directly; no merged-settings file needed";
    case "version-unknowable":
      return "plugin version is unreadable \u2014 leaving the existing merged settings untouched";
    case "missing-settings":
      return "no merged settings exist yet";
    case "not-autonomous":
      return "this session is not autonomous";
    case "stale-version":
      return `merged settings are stale (v${onDiskVersion ?? "?"} \u2192 v${pluginVersion ?? "?"})`;
    case "unstamped":
      return "merged settings predate version stamping (treated as stale)";
  }
}
async function runAutonomyPreflight(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir3();
  const write = opts.writeStdout ?? ((t) => process.stdout.write(t));
  let dataDir;
  let pluginRoot;
  try {
    dataDir = opts.dataDir ?? resolveDataDir();
  } catch {
  }
  try {
    pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
  } catch {
  }
  const path3 = dataDir !== void 0 ? mergedSettingsPath(dataDir) : "";
  const mergedSettingsPresent = path3.length > 0 && existsSync8(path3);
  const pluginVersion = pluginRoot !== void 0 ? await readPluginVersion(pluginRoot) : void 0;
  const onDiskVersion = mergedSettingsPresent ? await readOnDiskVersion(path3) : void 0;
  const decision = decideAutonomyPreflight({
    autonomous: isAutonomous(env),
    mergedSettingsPresent,
    pluginVersion,
    onDiskVersion
  });
  const verdict = describePreflightReason(decision.reason, pluginVersion, onDiskVersion);
  if (decision.regenerate) {
    if (dataDir === void 0 || pluginRoot === void 0) {
      write(
        `HALT: ${verdict}.
Cannot resolve the plugin data/root dir to scaffold autonomous settings here \u2014 run \`factory autonomy ensure\` once the environment is set, then relaunch with the printed command.
`
      );
      return EXIT.ERROR;
    }
    await runAutonomyEnsure({
      dataDir,
      pluginRoot,
      userSettingsPath: opts.userSettingsPath,
      home,
      writeStdout: write
    });
    write(`
HALT: ${verdict} \u2014 relaunch to continue (command above).
`);
    return EXIT.ERROR;
  }
  write(`OK: autonomous mode ready \u2014 ${verdict}.
`);
  return EXIT.OK;
}
async function run8(argv) {
  const args = parseArgs(argv, { booleans: ["json"] });
  if (args.flag("help") === true) {
    emitLine(HELP8);
    return EXIT.OK;
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
  describe: "Materialize merged-settings.json for an autonomous relaunch + print the command",
  run: async (argv) => {
    try {
      return await run8(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`autonomy: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  }
};

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
  resume: resumeCommand,
  run: runCommand,
  spec: specCommand,
  rescue: rescueCommand,
  score: scoreCommand,
  state: stateCommand,
  scaffold: scaffoldCommand,
  drive: driveCommand,
  next: nextCommand,
  statusline: statuslineCommand,
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
    ...names.map((n) => `  ${n.padEnd(width)}  ${cliRegistry[n].describe}`),
    "",
    "Run `factory <subcommand> --help` for subcommand-specific help."
  ];
  process.stdout.write(lines.join("\n") + "\n");
}
async function dispatch2(argv) {
  const [name, ...rest] = argv;
  if (name === void 0 || name === "--help" || name === "-h") {
    printHelp();
    return EXIT.OK;
  }
  const cmd = cliRegistry[name];
  if (!cmd) {
    process.stderr.write(
      `factory: unknown subcommand '${name}'. Run \`factory --help\` for usage.
`
    );
    return EXIT.USAGE;
  }
  return cmd.run(rest);
}

// src/bin/factory.ts
dispatch2(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(detail + "\n");
  process.exit(EXIT.ERROR);
});
