const readline = require('readline')
const sqlite3 = require('sqlite3').verbose()
const bs58 = require("bs58").default || require("bs58")
const axios = require('axios')
const cloudscraper = require('cloudscraper')
const { HttpsProxyAgent } = require('https-proxy-agent')
const db = new sqlite3.Database('flow3.db')
const nacl = require("tweetnacl")
const chalk = require('chalk')
const Table = require('cli-table3')

// PROXY Configuration - Set proxy only if defined
const PROXY = "" // FORMAT http://user:pass@ip:port or SET EMPTY IF PROXYLESS

let agent = null
if (PROXY) {
    agent = new HttpsProxyAgent(PROXY)
    axios.defaults.httpsAgent = agent // Set proxy agent
    axios.defaults.proxy = false

}

// Setup CLI interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

// Initialize DB
function initDB() {
    console.log(chalk.blue('Initializing database...'))
    db.run("CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY, publicKey TEXT, privateKey TEXT, accessToken TEXT)", (err) => {
        if (err) {
            console.log(chalk.red('Database initialization failed: ' + err.message))
            return
        }
        console.log(chalk.green('Database initialized successfully'))
        startCLI()
    })
}

// ** Generate Solana Wallet **
async function generateSolanaWallet() {
    const keyPair = nacl.sign.keyPair()
    const publicKey = bs58.encode(Uint8Array.from(keyPair.publicKey))
    const privateKey = bs58.encode(Uint8Array.from(keyPair.secretKey))
    return { publicKey, privateKey }
}

function signMessage(privateKeyString, message) {
    // Decode the private key from base58 string to Uint8Array
    const privateKeyBytes = bs58.decode(privateKeyString)
    const messageUint8 = new TextEncoder().encode(message)
    const signatureUint8 = nacl.sign.detached(messageUint8, privateKeyBytes)
    return bs58.encode(signatureUint8) // Encode signature in base58
}

// Test proxy connection
async function testProxyConnection() {
    console.log(chalk.blue('Testing proxy connection...'))

    try {
        const response = await axios.get('https://api.ipify.org?format=json', {
            httpsAgent: agent,
            timeout: 10000
        })
        console.log(chalk.green(`Proxy connection successful! IP: ${response.data.ip}`))
        return true
    } catch (error) {
        console.log(chalk.red(`Proxy connection failed: ${error.message}`))
        if (error.code === 'ECONNREFUSED') {
            console.log(chalk.yellow('Make sure the proxy server is running and accessible.'))
        }
        if (error.response && error.response.status === 407) {
            console.log(chalk.yellow('Proxy authentication error. Check your username and password.'))
        }
        return false
    }
}

// Refresh token for a wallet
async function refreshToken(publicKey, privateKey) {
    try {
        const message = "Please sign this message to connect your wallet to Flow 3 and verifying your ownership only."
        const signature = signMessage(privateKey, message)

        const response = await axios.post("https://api.flow3.tech/api/v1/user/login", {
            message,
            walletAddress: publicKey,
            signature,
            referralCode: "", // Not needed for refresh
        }, {
            httpsAgent: agent,
            proxy: false,
            timeout: 35000
        })

        if (response.data && response.data.data && response.data.data.accessToken) {
            const accessToken = response.data.data.accessToken

            // Update token in database
            db.run("UPDATE wallets SET accessToken = ? WHERE publicKey = ?", [accessToken, publicKey])

            return accessToken
        }
        return null
    } catch (error) {
        console.error(`Token refresh failed for ${publicKey}: ${error.message}`)
        return null
    }
}

// Sign up wallets
async function signupWallets(referralCode, count) {
    // Test proxy first
    const proxyWorking = await testProxyConnection()
    if (!proxyWorking) {
        rl.question(chalk.yellow("\nProxy connection failed. Do you want to continue anyway? (y/n): "), (answer) => {
            if (answer.toLowerCase() === 'y') {
                console.log(chalk.yellow('Continuing with potentially broken proxy...'))
                proceedWithSignup(referralCode, count)
            } else {
                startCLI()
            }
        })
    } else {
        proceedWithSignup(referralCode, count)
    }
}

async function proceedWithSignup(referralCode, count) {
    const walletTable = new Table({
        head: [
            chalk.blue('Index'),
            chalk.blue('Wallet Address'),
            chalk.blue('Status')
        ],
        colWidths: [10, 45, 30]
    })

    for (let i = 0;i < count;i++) {
        walletTable.push([i + 1, chalk.yellow('Generating...'), chalk.yellow('Pending')])
        process.stdout.write('\033[2J\033[0f')  // Clear screen
        console.log(chalk.blue.bold('Flow3 Wallet Generator'))
        console.log(walletTable.toString())
    }

    for (let i = 0;i < count;i++) {
        try {
            const { publicKey, privateKey } = await generateSolanaWallet()
            const message = "Please sign this message to connect your wallet to Flow 3 and verifying your ownership only."

            walletTable[i][1] = publicKey
            walletTable[i][2] = chalk.yellow('Signing...')
            process.stdout.write('\033[2J\033[0f')  // Clear screen
            console.log(chalk.blue.bold('Flow3 Wallet Generator'))
            console.log(walletTable.toString())

            try {
                const signature = signMessage(privateKey, message)

                walletTable[i][2] = chalk.yellow('Registering...')
                process.stdout.write('\033[2J\033[0f')  // Clear screen
                console.log(chalk.blue.bold('Flow3 Wallet Generator'))
                console.log(walletTable.toString())

                // Modified axios call with proper proxy configuration
                const response = await axios.post("https://api.flow3.tech/api/v1/user/login", {
                    message,
                    walletAddress: publicKey,
                    signature,
                    referralCode: referralCode,
                }, {
                    httpsAgent: agent,
                    proxy: false,  // Disable axios default proxy
                    timeout: 35000 // Increase timeout
                })

                if (response.data && response.data.data) {
                    const accessToken = response.data.data.accessToken
                    db.run("INSERT INTO wallets (publicKey, privateKey, accessToken) VALUES (?, ?, ?)",
                        [publicKey, privateKey, accessToken])
                    walletTable[i][2] = chalk.green('Success')
                } else {
                    walletTable[i][2] = chalk.red('Failed - No Data')
                }
            } catch (error) {
                console.error("API Error Details:", error.message)
                if (error.response) {
                    console.error("Status:", error.response.status)
                    console.error("Headers:", JSON.stringify(error.response.headers))
                    console.error("Data:", JSON.stringify(error.response.data))
                }

                walletTable[i][2] = chalk.red(`Error: ${error.response ? error.response.status : error.message}`)
            }
        } catch (error) {
            walletTable[i][2] = chalk.red(`Generation Error: ${error.message}`)
        }

        process.stdout.write('\033[2J\033[0f')  // Clear screen
        console.log(chalk.blue.bold('Flow3 Wallet Generator'))
        console.log(walletTable.toString())
    }

    rl.question(chalk.blue("\nSignup completed. Do you want to run Nodes now? (y/n): "), (answer) => {
        if (answer.toLowerCase() === 'y') {
            startMtcRequests()
        } else {
            startCLI()
        }
    })
}

// Run requests for all wallets
function startMtcRequests() {
    db.all("SELECT accessToken, publicKey, privateKey FROM wallets", (err, rows) => {
        if (err) {
            console.log(chalk.red("Error fetching tokens:", err))
            return
        }

        if (rows.length === 0) {
            console.log(chalk.yellow("No wallets found. Create wallets first."))
            return startCLI()
        }

        const statsTable = new Table({
            head: [
                chalk.blue('Wallet'),
                chalk.blue('Requests'),
                chalk.blue('Success'),
                chalk.blue('Failed'),
                chalk.blue('Total Time'),
                chalk.blue('Last Status')
            ],
            colWidths: [20, 12, 12, 12, 15, 20]
        })

        const stats = {}
        rows.forEach(row => {
            const shortAddress = row.publicKey.slice(0, 8) + '...' + row.publicKey.slice(-6)
            stats[row.publicKey] = {
                requests: 0,
                success: 0,
                failed: 0,
                totalTime: 0,
                status: 'Ready',
                accessToken: row.accessToken,
                privateKey: row.privateKey,
                refreshing: false
            }
            statsTable.push([
                shortAddress,
                stats[row.publicKey].requests,
                stats[row.publicKey].success,
                stats[row.publicKey].failed,
                stats[row.publicKey].totalTime,
                chalk.blue(stats[row.publicKey].status)
            ])
        })

        console.log(chalk.blue.bold(`Running ${rows.length} nodes...`))

        // Update the table every 1 second
        const updateInterval = setInterval(() => {
            process.stdout.write('\033[2J\033[0f')  // Clear screen
            console.log(chalk.blue.bold(`Flow3 Node Runner - ${rows.length} nodes`))
            console.log(chalk.blue(`Last update: ${new Date().toLocaleTimeString()}`))
            console.log(statsTable.toString())
        }, 1000)

        // Start making requests
        rows.forEach((row, index) => {
            async function postRequest() {
                const walletInfo = stats[row.publicKey]

                // Skip this iteration if currently refreshing token
                if (walletInfo.refreshing) return

                walletInfo.requests++
                walletInfo.status = 'Sending'
                statsTable[index][1] = walletInfo.requests
                statsTable[index][5] = chalk.yellow(walletInfo.status)

                const headers = {
                    "Accept": "application/json, text/plain, */*",
                    "Authorization": `Bearer ${walletInfo.accessToken}`,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
                }

                // Modified cloudscraper call with proper proxy handling
                const options = {
                    url: "https://api.mtcadmin.click/api/v1/bandwidth",
                    headers,
                    body: null,
                    proxy: PROXY,
                    timeout: 15000
                }

                try {
                    const response = await cloudscraper.post(options)
                    try {
                        const data = JSON.parse(response)
                        walletInfo.success++
                        walletInfo.status = 'Success'

                        // Extract and update totalTime from the response
                        if (data.data && data.data.totalTime !== undefined) {
                            // Convert to number and add to running total
                            const timeValue = Number(data.data.totalTime) || 0
                            walletInfo.totalTime += timeValue
                            statsTable[index][4] = walletInfo.totalTime.toFixed(2)
                        }

                        statsTable[index][2] = walletInfo.success
                        statsTable[index][5] = chalk.green(walletInfo.status)
                    } catch (e) {
                        walletInfo.status = 'Parse Error'
                        statsTable[index][5] = chalk.yellow(walletInfo.status)
                    }
                } catch (error) {
                    walletInfo.failed++

                    // Check if unauthorized (token expired)
                    const isUnauthorized = error.statusCode === 401 ||
                        (error.message && error.message.includes('unauthorized'))

                    if (isUnauthorized) {
                        walletInfo.status = 'Token Expired'
                        statsTable[index][5] = chalk.yellow(walletInfo.status)

                        // Refresh token
                        walletInfo.refreshing = true
                        statsTable[index][5] = chalk.cyan('Refreshing Token...')

                        try {
                            const newToken = await refreshToken(row.publicKey, walletInfo.privateKey)
                            if (newToken) {
                                walletInfo.accessToken = newToken
                                walletInfo.status = 'Token Refreshed'
                                statsTable[index][5] = chalk.green(walletInfo.status)
                            } else {
                                walletInfo.status = 'Refresh Failed'
                                statsTable[index][5] = chalk.red(walletInfo.status)
                            }
                        } catch (refreshError) {
                            walletInfo.status = 'Refresh Error'
                            statsTable[index][5] = chalk.red(walletInfo.status)
                        }

                        walletInfo.refreshing = false
                    } else {
                        walletInfo.status = `Failed: ${error.statusCode || error.message}`
                        statsTable[index][3] = walletInfo.failed
                        statsTable[index][5] = chalk.red(walletInfo.status)
                    }
                }
            }

            // Initial request
            postRequest()

            // Set up interval with random timing between 30-60 seconds
            function scheduleNextRequest() {
                const randomInterval = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000 // Random between 30-60 seconds
                setTimeout(() => {
                    postRequest()
                    scheduleNextRequest() // Schedule the next request
                }, randomInterval)
            }

            // Schedule the first request after the initial one
            scheduleNextRequest()
        })

        // Handle Ctrl+C to exit gracefully
        process.on('SIGINT', () => {
            clearInterval(updateInterval)
            console.log(chalk.blue('\nStopping node requests...'))
            process.exit(0)
        })
    })
}

// CLI Menu
function startCLI() {
    console.log(chalk.blue.bold("\n=== Flow3 Bot ==="))
    console.log(chalk.blue("1. Signup Wallet"))
    console.log(chalk.blue("2. Run Node"))
    console.log(chalk.blue("3. Test Proxy Connection"))
    console.log(chalk.blue("4. Exit"))
    rl.question(chalk.blue("Choose an option: "), (option) => {
        if (option === "1") {
            rl.question(chalk.blue("Enter referral code: "), (referralCode) => {
                rl.question(chalk.blue("How many wallets to generate? "), (count) => {
                    signupWallets(referralCode, parseInt(count))
                })
            })
        } else if (option === "2") {
            startMtcRequests()
        } else if (option === "3") {
            testProxyConnection().then(() => {
                rl.question(chalk.blue("\nPress Enter to continue..."), () => {
                    startCLI()
                })
            })
        } else if (option === "4") {
            console.log(chalk.blue("Exiting..."))
            rl.close()
        } else {
            console.log(chalk.red("Invalid option"))
            startCLI()
        }
    })
}

// Start the application
initDB()