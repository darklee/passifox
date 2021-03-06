var keySize = 8; // wtf?  stupid cryptoHelpers
    var associated = false;
    var errorMessage = null;
    var KEEPASS_HTTP_URL = "http://localhost:19455/";
    var CHROMEIPASS_CACHE_TIME = 30 * 1000; // millis

    var KEYNAME = "chromeipass-cryptokey-name";
    var KEYBODY = "chromeipass-key";

    var _cache = {};

    var to_s = cryptoHelpers.convertByteArrayToString;
    var to_b = cryptoHelpers.convertStringToByteArray;

    function b64e(d) {
        return btoa(to_s(d));
    }
    function b64d(d) {
        return to_b(atob(d));
    }

    function showPageAction(callback, tab) {
        if (!isConfigured() || errorMessage)
            chrome.browserAction.setIcon({ tabId: tab.id, path: "keepass-x.png" });
        else
            chrome.browserAction.setIcon({ tabId: tab.id, path: "keepass.png" });
        chrome.browserAction.setPopup({ tabId: tab.id, popup: "popup.html" });
        chrome.browserAction.enable(tab.id);
    }
    function hidePageAction(callback, tab) {
        chrome.browserAction.hide(tab.id);
    }

    function showAlert(callback, tab, message) {
        alert(message);
    }
    var tab_login_list = {};
    function selectLoginPopup(callback, tab, logins) {
        chrome.browserAction.setIcon({ tabId: tab.id, path: "keepass-q.png" });
        chrome.browserAction.setPopup({
                tabId: tab.id,
                popup: "login_popup.html"
        });
        tab_login_list["tab" + tab.id] = logins;
        chrome.browserAction.enable(tab.id);
    }

    chrome.tabs.onRemoved.addListener(function(tabId, info) {
        delete tab_login_list["tab" + tabId];
    });

    function selectFieldPopup(callback, tab) {
        chrome.browserAction.setIcon({ tabId: tab.id, path: "keepass-bang.png" });
        chrome.browserAction.setPopup({
                tabId: tab.id,
                popup: "field_popup.html"
        });
        chrome.browserAction.enable(tab.id);
    }

    function getPasswords(callback, tab, url, submiturl, force) {
        console.log("url + submiturl: [" + url + "] => [" + submiturl + "]");
        //_prune_cache();
        showPageAction(null, tab);
        /*
        var cached = _find_cache_item(url, submiturl);
        if (cached && !force) {
            callback(cached);
            return;
        }
        */
        if (!_test_associate()) {
            errorMessage = "Association was unsuccessful";
            showPageAction(null, tab);
            return;
        }
        var request = {
            RequestType: "get-logins"
        };
        var result = _set_verifier(request);
        var id = result[0];
        var key = result[1];
        var iv = request.Nonce;
        request.Url = b64e(slowAES.encrypt(to_b(url),
                slowAES.modeOfOperation.CBC, b64d(key), b64d(iv)));
        if (submiturl)
            request.SubmitUrl = b64e(slowAES.encrypt(to_b(submiturl),
                slowAES.modeOfOperation.CBC, b64d(key), b64d(iv)));
        result = _send(request);
        var s = result[0];
        var response = result[1];
        var entries = [];
        if (_success(s)) {
            var r = JSON.parse(response);
            if (_verify_response(r, key, id)) {
                var iv = r.Nonce;
                for (var i = 0; i < r.Entries.length; i++) {
                    _decrypt_entry(r.Entries[i], key, iv);
                }
                entries = r.Entries;
                //_cache_item(url, submiturl, entries);
            } else {
                //_cache_item(url, submiturl, []);
                console.log("getPasswords for " + url + " rejected");
            }
        }
        callback(entries);
    }
    function isConfigured() {
        return KEYNAME in localStorage && KEYBODY in localStorage;
    }
    function getStatus(callback) {
        var configured = isConfigured();
        var keyname;
        if (configured)
            keyname = localStorage[KEYNAME];
        if (!configured || errorMessage) {
            chrome.tabs.getSelected(null, function(tab) {
                chrome.browserAction.setIcon({
                        tabId: tab.id, path: "keepass-x.png"
                });
            });
        }
        callback({
            configured: configured,
            keyname: keyname,
            associated: associated,
            error: errorMessage
        });
        errorMessage = null;
    }
    function associate(callback) {
        if (associated) return;
        var rawkey = cryptoHelpers.generateSharedKey(keySize * 2);
        var key = b64e(rawkey);
        var request = {
            RequestType: "associate",
            Key: key
        };
        _set_verifier(request, key);
        var result = _send(request);
        if (_success(result[0])) {
            var r = JSON.parse(result[1]);
            var id = r.Id;
            if (!_verify_response(r, key)) {
                errorMessage = "KeePass association failed, try again";
            } else {
                _set_crypto_key(id, key);
                associated = true;
            }
            chrome.tabs.getSelected(null, function(tab) {
                showPageAction(callback, tab);
            });
        }
    }

    var requestHandlers = {
        'show_actions': showPageAction,
        'get_passwords': getPasswords,
        'select_login': selectLoginPopup,
        'select_field': selectFieldPopup,
        'get_status': getStatus,
        'associate': associate,
        'alert': showAlert
    };

    function onRequest(request, sender, callback) {
        if (request.action in requestHandlers) {
            var args = request.args || [];
            args.unshift(sender.tab);
            args.unshift(callback);
            requestHandlers[request.action].apply(this, args);
        }
    }
    chrome.extension.onMessage.addListener(onRequest);

///////////////////////////////////////////////////////////////////////////////

    function _test_associate() {
        if (associated) {
            return true;
        }
        var request = {
            "RequestType": "test-associate",
        };
        var info = _set_verifier(request);
        if (!info) return false;
        var id = info[0];
        var key = info[1];
        var result = _send(request);
        var s = result[0];
        var response = result[1];
        if (_success(s)) {
            var r = JSON.parse(response);
            if (!_verify_response(r, key, id)) {
                delete localStorage[KEYNAME];
                errorMessage = "Encryption key is unrecognized";
                console.log("Encryption key is unrecognized!");
            }
        }
        return associated;
    }
    function _set_verifier(request, inkey) {
        var key = null;
        var id = null;
        if (inkey) {
            key = inkey;
        } else {
            var info = _get_crypto_key();
            if (info == null) {
                return null;
            }
            id = info[0];
            key = info[1];
        }
        if (id) request.Id = id;
        var iv = cryptoHelpers.generateSharedKey(keySize);
        request.Nonce = b64e(iv);
        var decodedKey = b64d(key);
        request.Verifier = b64e(slowAES.encrypt(to_b(request.Nonce),
                slowAES.modeOfOperation.CBC, b64d(key), iv));
        return [id, key];
    }
    function _verify_response(response, key, id) {
        associated = response.Success;
        if (!response.Success) return false;
        var iv = response.Nonce;
        var crypted = response.Verifier;
        var value = slowAES.decrypt(b64d(crypted),
                slowAES.modeOfOperation.CBC, b64d(key), b64d(iv));
        value = to_s(value);
        associated = value == iv;
        if (id) {
            associated = associated && id == response.Id;
        }
        return associated;

    }
    function _get_crypto_key() {
        var keyname = localStorage[KEYNAME];
        var key = null;
        if (keyname) {
            key = localStorage[KEYBODY];
        }
        return key ? [keyname, key] : null;
    }
    function _set_crypto_key(id, key) {
        localStorage[KEYNAME] = id;
        localStorage[KEYBODY] = key;
    }

    function _find_cache_item(url, submiturl) {
        var key = url + "!!" + submiturl;
        var item = _cache[key];
        var now = Date.now();
        if (item && (item.ts + CHROMEIPASS_CACHE_TIME) > now) {
            item.ts = now;
            return item.entries;
        }
        return null;
    }
    function _cache_item(url, submiturl, entries) {
        var key = url + "!!" + submiturl;
        var item = {};
        item.ts = Date.now();
        item.entries = entries;
        _cache[key] = item;
    }
    function _prune_cache() {
        var now = Date.now();
        for (var i in _cache) {
            var item = _cache[i];
            if ((item.ts + CHROMEIPASS_CACHE_TIME) < now) delete _cache[i];
        }
    }
    function _decrypt_entry(e, key, iv) {
        e.Login = UTF8.decode(to_s(slowAES.decrypt(b64d(e.Login),
                slowAES.modeOfOperation.CBC, b64d(key), b64d(iv))));
        e.Uuid = to_s(slowAES.decrypt(b64d(e.Uuid),
                slowAES.modeOfOperation.CBC, b64d(key), b64d(iv)));
        e.Name = UTF8.decode(to_s(slowAES.decrypt(b64d(e.Name),
                slowAES.modeOfOperation.CBC, b64d(key), b64d(iv))));
        e.Password = UTF8.decode(to_s(slowAES.decrypt(b64d(e.Password),
                slowAES.modeOfOperation.CBC, b64d(key), b64d(iv))));
    }
    function _success(s) {
        var success = s >= 200 && s <= 299;
        if (!success) {
            errorMessage = "Unknown error: " + s;
            console.log("error: "+ s);
            if (s == 503) {
                console.log("KeePass database is not open");
                errorMessage = "KeePass database is not open";
            } else if (s == 0) {
                console.log("could not connect to keepass");
                errorMessage = "Is KeePassHttp installed and/or " +
                        "is KeePass running?";
            }
        }
        return success;
    }
    function _send(request) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", KEEPASS_HTTP_URL, false);
        xhr.setRequestHeader("Content-Type", "application/json");
        try {
            var r = JSON.stringify(request);
            console.log("Request: " + r);
            xhr.send(r);
        }
        catch (e) { console.log("KeePassHttp: " + e); }
        console.log("Response: " + xhr.status + " => " + xhr.responseText);
        return [xhr.status, xhr.responseText];
    }

    chrome.contextMenus.create({
        "title": "Fill User + Pass",
        "contexts": [ "editable" ],
        "onclick": function(info, tab) {
            chrome.tabs.sendMessage(tab.id, { action: "fill_user_pass" });
        }
    });
    chrome.contextMenus.create({
        "title": "Fill Pass Only",
        "contexts": [ "editable" ],
        "onclick": function(info, tab) {
            chrome.tabs.sendMessage(tab.id, { action: "fill_pass_only" });
        }
    });