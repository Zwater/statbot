// Load up the discord.js library
const Discord = require("discord.js");
const client = new Discord.Client();
const Influx = require('influx');
const config = require("./config.json");
const elasticsearch = require('elasticsearch');
const request = require('request');
if (config.elastic.enabled == "true") {
    var elastic = new elasticsearch.Client({
        host: config.elastic.host
    });
}
var checkusers = {}
client.on("ready", () => {
    console.log(`Bot has started, with ${client.users.size} users, in ${client.channels.size} channels of ${client.guilds.size} guilds.`);
    client.user.setActivity('With Data');
});
client.on("guildCreate", guild => {
    console.log(`New guild joined: ${guild.name} (id: ${guild.id}). This guild has ${guild.memberCount} members!`);
    client.user.setActivity(`Serving ${client.guilds.size} servers`);
});
client.on("guildDelete", guild => {
    console.log(`I have been removed from: ${guild.name} (id: ${guild.id})`);
    client.user.setActivity(`Serving ${client.guilds.size} servers`);
});
// Initialize InfluxDB
// 
var influx = new Influx.InfluxDB({
    host: config.influx.host,
    database: config.influx.database,
    username: config.influx.username,
    password: config.influx.password,
    schema: [
        {
            measurement: 'chatMessage',
            fields: {
                messageSent: Influx.FieldType.INTEGER,
                authorID: Influx.FieldType.STRING,
                authorName: Influx.FieldType.STRING,
                messageID: Influx.FieldType.STRING,
                messageLength: Influx.FieldType.INTEGER,
                messageText: Influx.FieldType.STRING,
                messageToxicity: Influx.FieldType.FLOAT,
                channelID: Influx.FieldType.STRING,
                channelName: Influx.FieldType.STRING,
                serverID: Influx.FieldType.STRING,
                serverName: Influx.FieldType.STRING,
                joinDate: Influx.FieldType.INTEGER,
                leaveDate: Influx.FieldType.INTEGER,
                xp: Influx.FieldType.INTEGER,
                wordCount: Influx.FieldType.INTEGER,
            },
            tags: [
                'author',
                'server',
                'serverName',
                'channel',
                'channelName'
            ]
        }
    ]
})
async function doRoles(message, xp) {
    // This function creates and assigns roles automatically based on the XP value
    // reported from InfluxDB. Also assigns embed roles, if they exist, for servers
    // with embeds disabled in channels, to keep spam down
    //
    var xpLevels = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000]
    xpLevels.forEach(function assignRoles(xpValue){
        if (xp >= xpValue) {
            // Embeds stuff
            //
            if (xpValue == 2500 && !message.member.roles.find(role => role.name === '2500xp')) {
                if (message.guild.roles.find(role => role.name === 'embeds')) {
                    message.member.addRole(message.guild.roles.find(role => role.name === 'embeds'))
                }
            }
            if (!message.guild.roles.find(role => role.name === xpValue + 'xp')) {
                // If XP role doesn't exist, create it, then assign it to the user
                //
                message.guild.createRole({name: `${xpValue}xp`})
                    .then(giveRole => {
                        message.member.addRole(message.guild.roles.find(role => role.name === `${xpvalue}xp`))
                    })
                    .catch(error => {
                        console.log(error)
                    })
            } else {
                message.member.addRole(message.guild.roles.find(role => role.name === xpValue + 'xp'))
            }
        }
    })
}
async function getXP(target) {
    var id = target.user.id
    // Queries influxDB, result is a number representing one point for each
    // five-minute block of time that a user has been active in the server
    //
    // This rewards sustained participation over a flood of messages, or perhaps
    // somebody with a habit of putting
    // their messages
    // on multiple
    // lines
    //
    var results = await influx.query(`SELECT cumulative_sum(max(\"messageSent\"))
        FROM \"chatMessage\"
        WHERE (\"author\" = \'${id}\')
        AND \"server\" =\'${target.guild.id}\'
        AND time >= 0ms
        GROUP BY time(5m)
        fill(null)`)
    // Write the value to influx so we don't have to do this heavy query quite so frequently
    //
    influx.writePoints([
        {
            measurement: 'chatMessage',
            tags: {
                author: target.user.id,
                server: target.guild.id,
                serverName: target.guild.name
            },
            fields: {
                xp: results[results.length - 1].cumulative_sum
            }
        }
    ])
    return(results[results.length - 1].cumulative_sum)
}
async function checkUser(message) {
    // This function is largely identical to the last one, but calls doRoles() at the end
    // Why?
    // Who knows.
    //
    influx.query(`SELECT cumulative_sum(max(\"messageSent\"))
        FROM \"chatMessage\"
        WHERE (\"author\" = \'${message.author.id}\')
        AND \"server\" =\'${message.guild.id}\'
        AND time >= 0ms
        GROUP BY time(5m)
        fill(null)`)
        .then(results =>{
            console.log('New check for user: ' + results[results.length - 1].cumulative_sum + ' XP')
            influx.writePoints([
                {
                    measurement: 'chatMessage',
                    tags: { 
                        author: message.author.id,
                        server: message.guild.id,
                        serverName: message.guild.name

                    },

                    fields: {
                        xp: results[results.length - 1].cumulative_sum
                    }
                }
            ])
            doRoles(message, results[results.length - 1].cumulative_sum)
        })
}


async function getUserData(message, m, args) {
    // This function, called by the command %info, makes a series of queries,
    // formats them, and returns them in a pretty embed message
    //
    if (message.mentions.users.array().length == 1) {
        // If %info is called while tagging someone, make the mentioned user the target
        //
        var mentions = message.mentions.users.array()
        var target = message.guild.members.find('id', mentions[0].id)
    } else if (args.length == 1) {
        // Else, if supplied, look up the ID passed in the command's arguments
        //
        var target = message.guild.members.find('id', args[0])
    } else {
        var target = message.member
    }
    var id = target.user.id
    var adjust = 0
    influx.query(
        [
            `SELECT SUM(adjust)
            FROM chatMessage
            WHERE \"author\"=\'${id}\'
            AND \"server\" =\'${message.guild.id}\'
            fill(0)`,

            `SELECT COUNT(messageSent)
            FROM chatMessage
            WHERE \"author\"=\'${id}\'
            AND \"server\" =\'${message.guild.id}\'
            fill(0)`,

            `SELECT COUNT(messageSent)
            FROM chatMessage
            WHERE \"author\"=\'${id}\'
            AND \"server\" =\'${message.guild.id}\'
            AND time > now() -7d`,

            `SELECT MEAN(messageLength)
            FROM chatMessage
            WHERE \"author\"=\'${id}\'
            AND \"server\" =\'${message.guild.id}\'
            AND time > now() - 7d
            FILL(0)`,

            `SELECT MOVING_AVERAGE(COUNT(messageSent),9)
            FROM chatMessage
            WHERE \"author\"=\'${id}\'
            AND \"server\" =\'${message.guild.id}\'
            AND time > now() - 7d
            GROUP BY time(1d)
            FILL(0)`,

            `SELECT COUNT(messageSent)
            FROM chatMessage
            WHERE \"author\"=\'${id}\'
            AND \"server\" =\'${message.guild.id}\'
            GROUP BY channelName`,

            `SELECT LAST(xp)
            FROM chatMessage
            WHERE \"author\"=\'${id}\'
            AND \"server\" =\'${message.guild.id}\'`
        ])
        .then(async results => {
            if (typeof results !== 'undefined') {
                if (typeof results[0][0] !== 'undefined') {
                    adjust = results[0].sum
                }
                // A bunch of variable declarations based on the query results
                // Should make this fail gracefully
                // Maybe one day
                //
                var totalMsgs = results[1][0].count + adjust
                var totalMsgsWk = results[2][0].count
                var avgLen = results[3][0].mean
                var avgMsgsD = results[4][0].moving_average
                var channelBrkdn = results[5]
                var xp = ''
                if (typeof results[6][0] == 'undefined'){
                    xp = await getXP(target)
                } else {
                    var xp = results[6][0].last
                }
                var ratio = Math.round((totalMsgs / xp) * 100) / 100
                var channel = ""
                var msgs
                var channelString = ""
                var other = 0
                var forceother = config.ignore_channels
                channelBrkdn.forEach(function(value){
                    // Generate the string for all-time channel participation, as a percentage
                    // of the user's all-time messages
                    // Also, ignore channels that we maybe don't want showing up in the breakdown
                    // Like private channels, modchat, NSFW, whatever. Add them to the "other channels" entry
                    if (value.count !== 'undefined'){
                        channel = value.channelName
                        msgs = value.count
                        var percent = Math.round(value.count * 100 / totalMsgs)
                        if (percent <= 1  || forceother.includes(channel)) {
                            other = other + percent
                        } else {
                            channelString = channelString + '**' + channel + '**' + ': ' + percent + '%' + '\n'
                        }
                    }
                })
                channelString = channelString + '**Other Channels**(1% or less): ' + other + '%\n'
                m.edit('', new Discord.RichEmbed({
                    author: {
                        name: target.displayName,
                        icon_url: target.user.displayAvatarURL
                    },
                    title: '**Server Activity Stats**',
                    fields: [
                        {name: '**Total messages, all time:**', value: totalMsgs},
                        {name: '**XP**: ', value: xp},
                        {name: '**Messages per XP:** ', value: ratio.toString()},
                        {name: '**Total messages, last 7 days:**', value: totalMsgsWk},
                        {name: '**Average messages per day, last 7 days:**', value: Math.round(avgMsgsD)},
                        {name: '**Average message length, last 7 days:**', value: Math.round(avgLen) + ' Characters'},
                        {name: '**All-time activity by channel:**', value: channelString
                        }
                    ]
                }))
            }
        })
    checkUser(message)
}

client.on("guildMemberAdd", async member => {
    var timestamp = new Date();
    var seconds = Math.round(timestamp / 1000);
    influx.writePoints([
        {
            measurement: 'chatMessage',
            tags: { 
                author: member.id,
                server: member.guild.id,
                serverName: member.guild.name
            },
            fields: {
                joinDate: seconds,
            }
        }
    ])
})
client.on("guildMemberRemove", async member => {
    var timestamp = new Date();
    var seconds = Math.round(timestamp / 1000);
    influx.writePoints([
        {
            measurement: 'chatMessage',
            tags: { 
                author: member.id,
                server: member.guild.id,
                serverName: member.guild.name

            },

            fields: {
                leaveDate: seconds
            }
        }
    ])
})

client.on("message", async message => {
    if(message.author.bot) return
    if(message.member.roles.find(val => val.name === 'Statbot-OptOut')) {
        var messageContents = ""
        var notoxic = true
    } else {
        var messageContents = message.cleanContent
    }
    if (checkusers[message.author.id] == null) {
        checkusers[message.author.id] = 0
    }
    checkusers[message.author.id] += 1
    if (checkusers[message.author.id] % 10 === 0) {
        // If a user has posted ten messages, update their XP and roles
        //
        checkUser(message)
    }
    if (message.cleanContent) {
        var wordCount = message.cleanContent.split(' ').length
    }
    log(message)
    function log(message) {
        influx.writePoints([
            {
                measurement: 'chatMessage',
                tags: {
                    author: message.author.id,
                    server: message.guild.id,
                    serverName: message.guild.name,
                    channel: message.channel.id,
                    channelName: message.channel.name,
                },
                fields: {
                    messageSent: '1',
                    authorID: message.author.id,
                    authorName: message.author.tag,
                    messageID: message.id,
                    messageLength: message.cleanContent.length,
                    messageText: messageContents,
                    channelID: message.channel.id,
                    channelName: message.channel.name,
                    serverID: message.guild.id,
                    serverName: message.guild.name,
                }
            }
        ])
        if (config.elastic.enabled == "true") {
            elastic.create({
                index: config.elastic.index,
                type: 'chatMessage',
                id: message.id,
                body: {
                    timestamp: new Date(),
                    authorID: message.author.id,
                    authorName: message.author.tag,
                    messageID: message.id,
                    messageLength: message.cleanContent.length,
                    messageText: messageContents,
                    channelID: message.channel.id,
                    channelName: message.channel.name,
                    serverID: message.guild.id,
                    serverName: message.guild.name
                }
            })
        }
    }
    if(message.content.indexOf(config.prefix) !== 0) return;
    const args = message.content.slice(config.prefix.length).trim().split(/ +/g);
    const command = args.shift().toLowerCase();
    if(command === "info") {
        const m = await message.channel.send("Fetching Data...")
        getUserData(message, m, args)
    }
});
client.login(config.token)
