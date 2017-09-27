var restify = require('restify');
var builder = require('botbuilder');
var parser = require('rss-parser');
var Europa = require('node-europa');
var elasticsearch = require('elasticsearch');
const http = require('http');
const https = require('https');
const request = require('request');
const europa = new Europa();

var elastichost = "192.168.192.16"
var elasticport = '9200';
var esIndex = "newsfeed";
var esType = "rss";

function connectES(host){
    var client = new elasticsearch.Client({
        host: host,
        log: 'trace'
    });
    if (!client){ return false };
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
    host = elastichost;
    protocol = "http://";
    myURLStr = protocol + host + "/" + indexStr;

    jsonBody = {
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
    }

        var clientServerOptions = {
            uri: myURLStr,
            port: elasticport,
            body: JSON.stringify(jsonBody),
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            }
        }
        request(clientServerOptions, function (error, response) {
            if (error) {
                console.log("Add Index Error: ");
                console.log(error, response.body);
                return;
            }
        });
}

process.env.ESHOST = "192.168.192.16:9200"

if(process.env.ESHOST) {
    console.log('It is set!');
    elastichost = process.env.ESHOST;
}
else {
    console.log('ESHOST is not set!');
    console.log('Using localhost on port 80.');
}

function addArticleToES(indexStr,typeStr,id, urlStr, titleStr, channel){
    host = elastichost;
    protocol = "http://";
    myURLStr = protocol + host + "/" + indexStr + "/" + typeStr + "/" + id + "-" + channel;
    var isodate = new Date().toISOString()

    jsonBody = {
        link: urlStr,
        channel: channel,
        title: titleStr,
        "@timestamp": isodate,
        published: true
    }

    var clientServerOptions = {
        uri: myURLStr,
        port: elasticport,
        body: JSON.stringify(jsonBody),
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json'
        }
    }
    request(clientServerOptions, function (error, response) {
        if (error) {
            console.log("Add To ES Error: ");
            console.log(error, response.body);
            return;
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
    host = elastichost;
    protocol = "http://";
    myURLStr = protocol + host + "/" + indexStr + "/" + typeStr + "/" + id + "-" + channel;

    jsonBody = {
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
        return;
    });

}

function searchFeed(session, urlStr, channel){
    var options = {
        customFields: {
            item: ['description']
        }
    }

    // Loop through articles in Feed.  Add them to elastic search if not there
    parser.parseURL(urlStr, options, function(err, parsed) {
        console.log(parsed.feed.title);
        rssId = new Buffer(urlStr).toString('base64');
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
            articleId = new Buffer(entry.guid).toString('base64');
            addArticles(session, entry, esIndex,"article",articleId, entry.guid, entry.pubDate, entry.link, entry.categories,channel);
        });
    });
}

function AddFeed(session) {
    session.send("Enter Feed Information:");
    session.beginDialog('getFeedInfo');
    return;
};

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
        var connector = new builder.ChatConnector({
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
                        AddFeed(session);
                        break;
                }
            } else {
                session.send('I am sorry but I didn\'t understand that. I need you to select one of the options below');
            }
        },
    ]);

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
        function (session, results) {
            session.beginDialog('askForFeedURL');
        },
        function (session, results) {
            session.dialogData.feedURL = results.response;

            // Process request and display reservation details
            session.send(`Reading Feed URL: ${session.dialogData.feedURL}<br\>`);
            searchFeed(session,session.dialogData.feedURL, session.message.address.channelId);
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

    });

}

