import dotenv from 'dotenv'

dotenv.config()

export async function sendDiscordMessage({ title, description, color = 3447003, fields = [], footer }) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL

    if (!webhookUrl) {
        console.warn('DISCORD_WEBHOOK_URL is not set')
        return
    }

    try {
        const embed = {
            title,
            description,
            color,
            fields,
            footer: {
                text: footer || 'RTC Draw - Server [SANDBOX:DIS]'
            },
            timestamp: new Date().toISOString()
        }

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                embeds: [embed]
            }),
        })

        if (!response.ok) {
            console.error(`Failed to send message: ${response.status} ${response.statusText}`)
        }
    } catch (error) {
        console.error('Error sending message:', error)
    }
}