const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const XMLHttpRequest = Components.Constructor("@mozilla.org/xmlextras/xmlhttprequest;1");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Prompt.jsm");

function loadIntoWindow(window) {
  if (!window)
    return;

  readerPlus.init(window);
}

function unloadFromWindow(window) {
  if (!window)
    return;

  readerPlus.uninit();
}

var BrowserApp;
var Reader;

var readerPlus = {
  pageaction : null,
  init: function(window) {
    BrowserApp = window.BrowserApp;
    NativeWindow = window.NativeWindow;
    Reader = window.Reader;

    BrowserApp.deck.addEventListener("TabOpen", this, false);
    BrowserApp.deck.addEventListener("TabClose", this, false);
    BrowserApp.deck.addEventListener("TabSelect", this, false);

    var tabs = BrowserApp.tabs;
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].browser.addEventListener("pageshow", this);
      readerPlus.parseBrowser(tabs[i].browser);
    }
  },

  uninit: function() {
    BrowserApp.deck.removeEventListener("TabOpen", this, false);
    BrowserApp.deck.removeEventListener("TabClose", this, false);
    BrowserApp.deck.removeEventListener("TabSelect", this, false);
    this.removePageAction();

    var tabs = BrowserApp.tabs;
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].browser.removeEventListener("pageshow", this);
        tabs[i].browser.__readerPlusLinks__ = null;
        delete tabs[i].browser.__readerPlusLinks__;
    }
    delete BrowserApp;
    delete NativeWindow;
    delete Reader;
  },

  handleEvent: function(event) {
    switch(event.type) {
      case "TabOpen":
        event.target.addEventListener("pageshow", this);
        break;
      case "TabClose":
        event.target.removeEventListener("pageshow", this);
        break;
      case "TabSelect":
        if (event.target.__readerPlusLinks__) {
            this.showPageAction(event.target.__readerPlusLinks__);
        } else {
            this.removePageAction();
        }
        break;
      case "pageshow":
        var browser = BrowserApp.getBrowserForDocument(event.target)
        if (!browser) return;
        if (browser.__readerPlusLinks__)
            browser.__readerPlusLinks__ = null;
        this.parseBrowser(browser);
        break;
    }
  },

  parseBrowser: function(browser) {
    if (!browser)
        return;

    Services.console.logStringMessage("Browser: " + browser);
    var links = browser.contentDocument.getElementsByTagName("link");
    if (links.length == 0) {
        browser.__readerPlusLinks__ = null;
        return;
    }

    for (var i = 0; i < links.length; i++) {
      this.addLink(links[i], browser);
    }

  },

  addLink: function(target, browser) {
    if (!target.href || target.disabled)
      return;

    // Sanitize the rel string
    let list = [];
    if (target.rel) {
      list = target.rel.toLowerCase().split(/\s+/);
      let hash = {};
      list.forEach(function(value) { hash[value] = true; });
      list = [];
      for (let rel in hash)
        list.push("[" + rel + "]");
    }

    if (list.indexOf("[alternate]") != -1) {
      let type = target.type.toLowerCase().replace(/^\s+|\s*(?:;.*)?$/g, "");
      let isFeed = (type == "application/rss+xml" || type == "application/atom+xml");

      if (!isFeed) {
        return;
      }

      
      try {
        this.getList(target.href, type, (function(err, feedlist) {

          if (!browser.__readerPlusLinks__) {
            browser.__readerPlusLinks__ = [];
          }

          browser.__readerPlusLinks__.push({
            title: target.getAttribute("title"),
            list: feedlist,
          });

          if (BrowserApp.selectedBrowser == browser)
            this.showPageAction(browser.__readerPlusLinks__);
        }).bind(this));
      } catch (e) {
        Services.console.logStringMessage(e);
      }
    }
  },

  getList: function(url, type, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.onload = (function (e) {
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          callback(null, this.parseAtom(xhr.responseXML));
        } else {
          callback(xhr.statusText, null);
        }
      }
    }).bind(this);
    xhr.onerror = function (e) {
      callback(xhr.statusText, null);
    };
    xhr.send(null);
  },

  parseAtom: function(xml) {
    var list = [];
    var ret = {};
    var items = xml.getElementsByTagName("item");
    for (var i = 0; i < items.length; i++) {
      list.push({
        title: items[i].getElementsByTagName("title")[0].textContent,
        link: items[i].getElementsByTagName("link")[0].textContent
      });
    }

    return {
      title: xml.getElementsByTagName("title")[0].textContent,
      list: list
    }
  },

  showPageAction: function(feedList) {
    if (this.pageaction)
      this.removePageAction();

    this.pageaction = NativeWindow.pageactions.add({
      title: "Add to reading list",
      icon: "chrome://readerplus/skin/feedIcon.png",
      clickCallback: function() {
        if (feedList.length > 1) {
          readerPlus.showSelectFeed(feedList);
        } else {
          readerPlus.showSelectArticles(feedList[0].list);
        }
      }});
  },

  showSelectArticles: function(list) {
    var p = new Prompt({
        title: list.title,
        buttons: ["OK", "Cancel"]
      }).setMultiChoiceItems(list.list.map(function(listItem) {
        return { label: listItem.title }
      })).show(function(data) {
        Services.console.logStringMessage(JSON.stringify(data));

        for (var i = 0; i < data.button.length; i++) {
          if (data.button[i]) {
            Services.console.logStringMessage("Adding: " + list.list[i].link)
            readerPlus.addToReadingList(list.list[i].link, list.list[i].title);
          }
        }
      });
  },

  showSelectFeed: function(list) {
    var p = new Prompt({ title: "Select a source" })
      .setSingleChoiceItems(list.map(function(listItem) {
        return { label: listItem.title }
      })).show(function(data) {
        Services.console.logStringMessage(JSON.stringify(data));

        readerPlus.showSelectArticles(list[data.button].list);
      });
  },

  removePageAction: function() {
    NativeWindow.pageactions.remove(this.pageaction);
  },

  addToReadingList: function(url, title) {
    let sendResult = function(result, title) {
      Cc["@mozilla.org/android/bridge;1"].getService(Ci.nsIAndroidBridge).handleGeckoMessage(JSON.stringify({
        type: "Reader:Added",
        result: result,
        title: title,
        url: url,
      }));
    };


    Reader.parseDocumentFromURL(url, function(article) {
        if (!article) {
          sendResult(this.READER_ADD_FAILED, "");
          return;
        }

        Reader.storeArticleInCache(article, function(success) {
          let result = (success ? this.READER_ADD_SUCCESS : this.READER_ADD_FAILED);
          sendResult(result, article.title);
        }.bind(Reader));
        // NativeWindow.toast.show("Added " + title + " to reading list", "short");
    });
  }
}

var windowListener = {
  onOpenWindow: function(aWindow) {
    // Wait for the window to finish loading
    let domWindow = aWindow.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowInternal || Ci.nsIDOMWindow);
    domWindow.addEventListener("load", function() {
      domWindow.removeEventListener("load", arguments.callee, false);
      loadIntoWindow(domWindow);
    }, false);
  },
  
  onCloseWindow: function(aWindow) {
  },
  
  onWindowTitleChange: function(aWindow, aTitle) {
  }
};

function startup(aData, aReason) {
  // Load into any existing windows
  let windows = Services.wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
    loadIntoWindow(domWindow);
  }

  // Load into any new windows
  Services.wm.addListener(windowListener);
}

function shutdown(aData, aReason) {
  // When the application is shutting down we normally don't have to clean
  // up any UI changes made
  if (aReason == APP_SHUTDOWN)
    return;

  // Stop listening for new windows
  Services.wm.removeListener(windowListener);

  // Unload from any existing windows
  let windows = Services.wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
    unloadFromWindow(domWindow);
  }
}

function install(aData, aReason) {
}

function uninstall(aData, aReason) {
}
