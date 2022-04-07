import axios from 'axios'

function formatTwitch (context, message) {
  return {
    mkdwn: true,
    attachments: [{
      color: '#6441A4',
      text: `${context.username}: ${message}`
    }]
  }
}

function formatFacebook (context, message) {
  return {
    mkdwn: true,
    attachments: [{
      color: '#3B5998',
      text: `${context.username}: ${message}`
    }]
  }
}

function formatTwitter (context, message) {
  return {
    mkdwn: true,
    attachments: [{
      color: '#1DA1F2',
      text: `${context.usernamename}: ${message}`
    }]
  }
}

function formatGeneric (context, message) {
  return {
    mkdwn: true,
    attachments: [{
      color: 'good',
      text: `${context.username}: ${message}`
    }]
  }
}

function getFormattedLinks (context, message) {
  const formatted = []
  const links = message.match(/(http|https):\/\/\S+/gi) || []

  links.forEach(link => {
    if (link.match(/twitch.tv/)) formatted.push(formatTwitch(context, link))
    else if (link.match(/facebook.com/)) formatted.push(formatFacebook(context, link))
    else if (link.match(/twitter.com/)) formatted.push(formatTwitter(context, link))
    else formatted.push(formatGeneric(context, link))
  })

  return formatted
}

const linkit = (context, message) => {
  if (typeof (message) !== 'undefined' && process.env.SLACK_LINKS_HOOK && process.env.SLACK_LINKS !== 'false') {
    const links = getFormattedLinks(context, message)
    if (links && links.length > 0) {
      return Promise.all(links.map(async link => axios.post(process.env.SLACK_LINKS_HOOK, link)
        .catch(err => console.error(`Error: unable to relay link to slack: ${link}: ${JSON.stringify(err)}`))))
    }
  }
}

export default linkit
