var restify = require('restify');
var builder = require('botbuilder');
var teams = require('botbuilder-teams');
var rssParser = require('rss-parser');
var Europa = require('node-europa');
var elasticsearch = require('elasticsearch');
const http = require('http');
const https = require('https');
const request = require('request');
const europa = new Europa();

var elastichost = "192.168.192.16";
var elasticport = '9200';
var esIndex = "newsfeed";

function connectES(host){
    var client = new elasticsearch.Client({
        host: host,
        log: 'trace'
    });
    if (!client){ return false }
    client.ping({
        // ping usually has a 3000ms timeout
        requestTimeout: 1000
    }, function (error) {
        if (error) {
            console.trace('elasticsearch cluster is down!');
            process.exit(-1);
        } else {
            console.log('All is well');
            return client;
        }
    });
}

function addIndex(indexStr){
    var host = elastichost;
    var protocol = "http://";
    var myURLStr = protocol + host + "/" + indexStr;

    var jsonBody = {
        "mappings": {
            "rss": {
                "properties": {
                    "title": {"type": "string", "index": "not_analyzed"},
                    "link": {"type": "string", "index": "not_analyzed"},
                    "channel": {"type": "string", "index": "analyzed"},
                    "@timestamp": {"type": "date", "format": "YYYY-MM-DD'T'HH:mm:ssZ"}
                }
            },
            "articles": {
                "properties": {
                    "guid": {"type": "string", "index": "not_analyzed"},
                    "published_at": {"type": "string", "index": "not_analyzed"},
                    "link": {"type": "string", "index": "not_analyzed"},
                    "channel": {"type": "string", "index": "analyzed"},
                    "@timestamp": {"type": "date","format":"YYYY-MM-DD'T'HH:mm:ssZ"},
                    "tags": {"type": "keyword","store": true}
                }
            }
        }
    };

        var clientServerOptions = {
            uri: myURLStr,
            port: elasticport,
            body: JSON.stringify(jsonBody),
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            }
        };
        request(clientServerOptions, function (error, response) {
            if (error) {
                console.log("Add Index Error: ");
                console.log(error, response.body);
            }
        });
}

process.env.ESHOST = "192.168.192.16:9200";

if(process.env.ESHOST) {
    console.log('It is set!');
    elastichost = process.env.ESHOST;
}
else {
    console.log('ESHOST is not set!');
    console.log('Using localhost on port 80.');
}

function addArticleToES(indexStr,typeStr,id, urlStr, titleStr, channel){
    var host = elastichost;
    var protocol = "http://";
    var myURLStr = protocol + host + "/" + indexStr + "/" + typeStr + "/" + id + "-" + channel;
    var isodate = new Date().toISOString();


    var jsonBody = {
        link: urlStr,
        channel: channel,
        title: titleStr,
        "@timestamp": isodate,
        published: true
    };

    var clientServerOptions = {
        uri: myURLStr,
        port: elasticport,
        body: JSON.stringify(jsonBody),
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json'
        }
    };
    request(clientServerOptions, function (error, response) {
        if (error) {
            console.log("Add To ES Error: ");
            console.log(error, response.body);
        }
    });
}

function postArticle(session, entry){
    //if (entry.isoDate === n) {
    console.log(entry.title + ':' + entry.link);
    console.log(entry.pubDate);
    console.log(entry.guid);
    //console.log(entry.categories);
    //console.log(entry.description);
    //console.log(entry.isoDate);


    var m,
        urls = [],
        rex = /<img[^>]+src="?([^"\s]+)"?\s*\/>/g;

    while (m = rex.exec(entry.description)) {
        urls.push(m[1]);
    }
    console.log(urls[0]);

    var msg = new builder.Message(session)
        .addAttachment({
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
                "type": "AdaptiveCard",
                "version": "0.5",
                "body":
                    [
                        {
                            "type": "Container",
                            "items": [
                                {
                                    "type": "TextBlock",
                                    "text": entry.title,
                                    "size": "medium",
                                    "weight": "bolder",
                                    "wrap": true
                                },
                                {
                                    "type": "TextBlock",
                                    "text": entry.pubDate,
                                    "size": "small",
                                    "weight": "bold"
                                },
                                {
                                    "type": "TextBlock",
                                    "text": europa.convert(entry.description),
                                    "wrap": true
                                }
                            ]
                        }
                    ],
                "actions": [
                    {
                        "type": "Action.OpenUrl",
                        "url": entry.link,
                        "title": "Learn More"
                    }
                ]
            }
        });
    session.send(msg).endDialog();


}

// This function adds Feed articles to elastic search and posts new ones to the current Microsoft Teams channel
function addArticles(session, entry, indexStr,typeStr,id, guid, pubDate, link, categories, channel, isoDate){
    var host = elastichost;
    var protocol = "http://";
    var myURLStr = protocol + host + "/" + indexStr + "/" + typeStr + "/" + id + "-" + channel;

    var jsonBody = {
            published_at: pubDate,
            guid: guid,
            link: link,
            channel: channel,
            tags: [categories],
            "@timestamp": isoDate,
            published: true
        };

    var clientServerOptions = {
        uri: myURLStr,
        port: elasticport,
        body: JSON.stringify(jsonBody),
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json'
        }
    };
    request(clientServerOptions, function (error, response) {
        var articleStatus = JSON.parse(response.body);

        if (error) {
            console.log("Add To ES Error: ");
            console.log(error, response.body);
        } else {
            if (articleStatus.created === true){
                postArticle(session, entry);
            } else {
                return false;
            }
        }
    });

}

function daysBetween(myDateStr1,myDateStr2){
    var myDate1 = new Date(myDateStr1);
    var myDate2 = new Date(myDateStr2);
    var timeDiff = myDate1 - myDate2;

    if (timeDiff > 1440e3) {
        var diffDays = Math.round(timeDiff / 60e3);
        diffDays = diffDays / 1440;
    } else {
        diffDays = 1.0;
    }
    return parseInt(diffDays, 10);
}

function isEmpty(str) {
    return (!str || 0 === str.length);
}

function searchFeed(session, urlStr, channel, daysToCheck){
    console.log("URL : " + urlStr);
    if (isEmpty(urlStr)) {
        //
    } else {
        rssParser.parseURL(urlStr, function(err, parsed) {
            if (err){
                console.log("Error: " + err);
                session.endDialog('There is some error');
            } else {
                console.log(parsed.feed.title);
                var rssId = new Buffer(urlStr).toString('base64');
                console.log(rssId);
                addArticleToES(esIndex,"rss",rssId,urlStr,parsed.feed.title,channel);

                parsed.feed.entries.forEach(function(entry) {
                    console.log("Title: " + entry.title);
                    //console.log("URL: " + entry.link);
                    //console.log("Date: " + entry.pubDate);
                    //console.log("GUID: "  + entry.guid);
                    //console.log("ID: " + new Buffer(entry.guid).toString('base64') + "-" + channel);
                    //console.log("Categories: " + entry.categories);
                    //console.log("Channel: " + channel);
                    //console.log("ISO Date: " + entry.isoDate);
                    var articleId = new Buffer(entry.guid).toString('base64');
                    var isodate = new Date().toISOString();

                    if (daysBetween(isodate, entry.isoDate) <= daysToCheck) {
                        addArticles(session, entry, esIndex, "article", articleId, entry.guid, entry.pubDate, entry.link, entry.categories, channel);
                    }
                });
            }
        });
    }
}

function AddFeed(session) {
    session.send("Enter Feed Information:");
    session.beginDialog('getFeedInfo');
}

function checkFeeds(session){
    //searchFeed(session, urlStr, channel, 7);
    var myDate = new Date();
    var myTime = myDate.toISOString();

    session.send("Ping " + myTime);
    console.log("Ping " + myTime);

    setTimeout(function(session2) {
        checkFeeds(session2);
    }, 60000, session);
}


var esClient = connectES(elastichost);
if (esClient === false ) {
    console.log("Elastic Search Client Failed.");
    process.exit(-1);
} else {
    addIndex("newsfeed");
    // Setup Restify Server
        var server = restify.createServer();
        server.listen(process.env.port || process.env.PORT || 3978, function () {
            console.log('%s listening to %s', server.name, server.url);
        });

    // Create chat connector for communicating with the Bot Framework Service
        var connector = new teams.TeamsChatConnector({
            appId: process.env.MICROSOFT_APP_ID,
            appPassword: process.env.MICROSOFT_APP_PASSWORD
        });

    // Listen for messages from users
        server.post('/api/messages', connector.listen());

    const ListFeedsOption = 'List Feeds';
    const AddFeedOption = 'Add Feed';
    const RemoveFeedOption = 'Remove Feed';
    const EditFeedOption = 'Edit Feed';
    const ViewFeedOption = 'View Feed';

    var bot = new builder.UniversalBot(connector, [
        function (session) {

        },
        function (session) {
            builder.Prompts.choice(session,
                'What do yo want to do today?',
                [ListFeedsOption, AddFeedOption, RemoveFeedOption, EditFeedOption, ViewFeedOption],
                { listStyle: builder.ListStyle.button });
            //console.log("channel name: " + );
        },
        function (session, result) {
            if (result.response) {
                switch (result.response.entity) {
                    case ListFeedsOption:
                        session.send('List Feeds');
                        session.reset();
                        break;
                    case AddFeedOption:
                        //session.beginDialog('FetchMemberList');
                        AddFeed(session);
                        break;
                }
            } else {
                session.send('I am sorry but I didn\'t understand that. I need you to select one of the options below');
            }
        }
    ]);

    /*
    bot.dialog('FetchMemberList', function (session) {
        var conversationId = session.message.address.conversation.id;
        connector.fetchMembers(session.message.address.serviceUrl, conversationId, function (err, result) {
            if (err) {
                session.endDialog('There is some error');
            }
            else {
                session.endDialog('%s', JSON.stringify(result));
            }
        });
    });
    */

    // Add first run dialog
    bot.dialog('firstRun', [
        function (session) {
            // Update versio number and start Prompts
            // - The version number needs to be updated first to prevent re-triggering
            //   the dialog.
            session.userData.version = 1.0;
            builder.Prompts.text(session, "Hello... What's your name?");
        },
        function (session, results) {
            // We'll save the users name and send them an initial greeting. All
            // future messages from the user will be routed to the root dialog.
            session.userData.name = results.response;
            session.endDialog("Hi %s, say something to me and I'll echo it back.", session.userData.name);
        }
    ]).triggerAction({
        onFindAction: function (context, callback) {
            // Trigger dialog if the users version field is less than 1.0
            // - When triggered we return a score of 1.1 to ensure the dialog is always triggered.
            var ver = context.userData.version || 0;
            var score = ver < 1.0 ? 1.1: 0.0;
            callback(null, score);
        },
        onInterrupted: function (session, dialogId, dialogArgs, next) {
            // Prevent dialog from being interrupted.
            session.send("Sorry... We need some information from you first.");
        }
    });

     // Dialog to ask for the reservation name.
    bot.dialog('askForFeedURL', [
        function (session) {
            builder.Prompts.text(session, "What is the Feed URL");
        },
        function (session, results) {
            session.endDialogWithResult(results);
        }
    ]);

    // This is a news feed bot that uses multiple dialogs to prompt users for input.
    bot.dialog('getFeedInfo', [
        function (session) {
            session.beginDialog('askForFeedURL');
        },
        function (session, results) {
            session.dialogData.feedURL = results.response;

            // Process request and display reservation details
            session.send(`Reading Feed URL: ${session.dialogData.feedURL}<br\>`);
            searchFeed(session,session.dialogData.feedURL, session.message.address.channelId, 7);
            session.endDialog();
        }
    ]);

    // Check if team or bot joined
    bot.on('conversationUpdate', (msg) => {
        if (msg.membersAdded && msg.membersAdded.length > 0) {
            var botId = msg.address.bot.id;

            var members = msg.membersAdded;
            // Loop through all members that were just added to the team
            for (var i = 0; i < members.length; i++) {
                // See if the member added was our bot
                if (msg.membersAdded[i].id === botId) {
                    var botmessage = new builder.Message()
                        .address(msg.address)
                        .text('Hello There. Thanks for the invite. I am MacBot. If you need some help just type "@macbot help" at any time');

                    bot.send(botmessage, function (err) {
                    });
                } else {
                    var botmessage = new builder.Message()
                        .address(msg.address)
                        .text('Welcome! I am MacBot. If you need some help just type "@macbot help" at any time');
                    bot.send(botmessage, function (err) {
                    });
                }
            }
        }

    })
}

