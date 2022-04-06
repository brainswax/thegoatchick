# TheGoatChick
Camera control for https://www.twitch.tv/thegoatchick

Originally based off [twitch-goat-cams](https://github.com/spencerlambert/twitch-goat-cams) developed by Farmer Spencer

# Configuration
The configuration consists of environment variables and configuration files located in the conf/ directory

## Environment Variables
The environment variables are stored in .env files. The NODE_ENV environment variable (development, test, production) decides which .env to use. When in production, it uses the .env.production file.

To change the environment, modify the start script in package.json, to something like:
```shell
cross-env NODE_ENV=development node -r esm --experimental-vm-modules src/goats.js
```
This will inherit the environment variables defined in .env.development

### SLACK_HOOK
```shell
SLACK_HOOK=https://hooks.slack.com/services/XXXXX
```
This is the [Slack Webhook](https://api.slack.com/messaging/webhooks#create_a_webhook) that is used to log messages to a slack channel if the SLACK_LOG environment variable is set to 'true'. Otherwise, it will just log to the console.

### SLACK_LOG
To enable logging to the slack channel, defined by the SLACK_HOOK, set to 'true'.
```shell
SLACK_LOG=true
```
To disable slack logging, set this to empty or anything other than 'true' and restart the application.

### SLACK_LINKS_HOOK
```shell
SLACK_LINKS_HOOK=https://hooks.slack.com/services/XXXXX
```
This is a [Slack Webhook](https://api.slack.com/messaging/webhooks#create_a_webhook) that is used to repost links sent from twitch messages to a slack channel if the SLACK_LINKS environment variable is not 'false'.

### SLACK_LINKS
To enable links to be reposted to slack, defined by the SLACK_LINKS_HOOK, set to 'true'.
```shell
SLACK_LINKS=true
```
To disable reposting links to slack, set this to 'false' or remove SLACK_LINKS_HOOK and restart the application.

### OBS_ADDRESS
The host and port to connect to the local OBS service.
```shell
OBS_ADDRESS=localhost:4444
```

### OBS_PASSWORD
The password associated with the OBS service defined by OBS_ADDRESS
```shell
OBS_PASSWORD=obspassword
```

### PTZ_CONFIG
The location of the PTZ camera config file.

```shell
PTZ_CONFIG=../conf/ptz.json
```

### TWITCH_USER
The twitch user that the bot will login as
```shell
TWITCH_USER=botusername
```

### TWITCH_CHANNEL
The twitch channel that the bot will join
```shell
TWITCH_CHANNEL=twitchstream
```

### TWITCH_TOKEN
This is an oauth token provided by twitch for the bot to authenticate. Go to [Twitch Apps](https://twitchapps.com/tmi/) get a new token for the Twitch Messaging Interface (tmi).

```shell
TWITCH_CHANNEL=twitchstream
```

To verify your token, you can run something like:
```shell
curl -H "Authorization: OAuth <insert oauth token>" https://id.twitch.tv/oauth2/validate
```

Which will return information about your token:

```JSON
{
  "client_id": "xxxxxxxx",
  "login": "brainswax",
  "scopes": ["channel:moderate","channel_editor","chat:edit","chat:read","whispers: edit","whispers:read"],
  "user_id": "0000000",
  "expires_in": 0
}
```

### TWITCH_RECONNECT
Twitch reconnects are enabled by default unless this is explicitly set to false
```shell
TWITCH_RECONNECT=false
```

### TWITCH_RECONNECT_TRIES
The number of reconnect attempts to twitch before giving up. By default, it will start after 1 second, then degrade till it attempts every 30 seconds. 2880 attempts is roughly 24 hours.

```shell
TWITCH_RECONNECT_TRIES=2880
```

### LOG_LEVEL_CONSOLE
Sets the level of logs sent to the console. The logger will only log at the specified level or higher severity.

From highest to lowest severity: EMERGENCY, ALERT, CRITICAL, ERROR, WARN, NOTICE, INFO, DEBUG

```shell
LOG_LEVEL_CONSOLE=DEBUG
```

### LOG_LEVEL_SLACK
Sets the level of logs sent to Slack (assuming SLACK_LOG=true). The logger will only log at the specified level or higher severity.

From highest to lowest severity: EMERGENCY, ALERT, CRITICAL, ERROR, WARN, NOTICE, INFO, DEBUG

```shell
LOG_LEVEL_SLACK=ERROR
```

## PTZ Config
The PTZ_CONFIG environment variable is used to specify the location of the PTZ cameras config file.

The file is expected to be JSON with the following example format:

```json
{
  "cams": {
     "Yard": {
       "hostname": "192.168.0.1",
       "username": "yarduser",
       "password": "yardpassword",
       "version": 2
     },
     "Does": {
       "hostname": "192.168.0.2",
       "username": "doesusername",
       "password": "doespassword",
       "version": 2
     }
  }
}
```
