const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const { client_id, client_secret, redirect_uri } = require("./credentials.json");

const port = 3000;
const all_sessions = [];
const server = http.createServer();

server.on("listening", listen_handler);
server.listen(port);

function listen_handler() {
    console.log(`Now Listening on Port ${port}`);
}

server.on("request", request_handler);

function request_handler(req, res) {
    console.log(`New Request from ${req.socket.remoteAddress} for ${req.url}`);
    if (req.url === "/") {
        const form = fs.createReadStream("index.html");
        res.writeHead(200, { "Content-Type": "text/html" });
        form.pipe(res);
    } else if (req.url.startsWith("/search_books")) {
        const user_input = new URL(req.url, `http://${req.headers.host}`).searchParams;
        const title = user_input.get("title");
        const author = user_input.get("author");
        if (title || author) {
            get_books_information({ title, author }, res);
        } else {
            not_found(res);
        }
    } else if (req.url.startsWith("/oauth2callback")) {
        const user_input = new URL(req.url, `http://${req.headers.host}`).searchParams;
        const code = user_input.get("code");
        const state = user_input.get("state");

        let session = all_sessions.find((session) => session.state === state);
        if (code && state && session) {
            send_access_token_request(code, session, res);
        } else {
            not_found(res);
        }
    } else {
        not_found(res);
    }
}

function not_found(res) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(`<h1>404 Not Found</h1>`);
}

function get_books_information(user_input, res) {
    const { title, author } = user_input;
    let query = "";
    if (title && author) {
        const formattedTitle = title.replace(/\s+/g, "+");
        query = `q=${formattedTitle}&author=${author}`;
    } else if (title) {
        const formattedTitle = title.replace(/\s+/g, "+");
        query = `q=${formattedTitle}`;
    } else if (author) {
        query = `author=${author}`;
    }

    const Endpoint = `https://openlibrary.org/search.json?${query}`;
    const options = {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0',
        },
    };

    const search_request = https.request(Endpoint, options, (apiResponse) => {
        let data = '';
        apiResponse.on('data', (chunk) => { data += chunk; });
        apiResponse.on('end', () => { receive_book_results(data, user_input, res); });
    });

    search_request.on('error', (error) => {
        console.error('Error:', error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
    });

    search_request.end();
}

function receive_book_results(body, user_input, res) {
    const booksData = JSON.parse(body);
    if (booksData.docs && booksData.docs.length > 0) {
        const books = booksData.docs.map((book) => {
            return {
                title: book.title,
                author_name: book.author_name,
                description: book.description || "No description available",
                url: `https://openlibrary.org${book.key}`,
                author_key: book.author_key
            };
        });

        const state = crypto.randomBytes(20).toString("hex");
        all_sessions.push({ books, state });
        redirect_to_google(state, res);
    } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("No Results Found");
    }
}

function redirect_to_google(state, res) {
    const authorization_endpoint = "https://accounts.google.com/o/oauth2/v2/auth";
    const uri = new URLSearchParams({
        client_id,
        redirect_uri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/drive.file",
        state
    }).toString();

    res.writeHead(302, { Location: `${authorization_endpoint}?${uri}` }).end();
}

function send_access_token_request(code, session, res) {
    const token_endpoint = "https://oauth2.googleapis.com/token";
    const post_data = new URLSearchParams({
        client_id,
        client_secret,
        code,
        redirect_uri,
        grant_type: "authorization_code"
    }).toString();
    const options = {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
    };
    const token_request = https.request(token_endpoint, options, (token_stream) => process_stream(token_stream, receive_access_token, session, res));
    token_request.on('error', (error) => {
        console.error('Error:', error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
    });
    token_request.end(post_data);
}

function process_stream(stream, callback, ...args) {
    let body = "";
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => callback(body, ...args));
}

function receive_access_token(body, session, res) {
    const { access_token } = JSON.parse(body);
    upload_books_to_drive(session.books, access_token, res);
}

function upload_books_to_drive(books, access_token, res) {
    let markdownContent = "# Books List\n\n";
    books.forEach(book => {
        const authorName = Array.isArray(book.author_name) ? book.author_name.join(", ") : "Unknown Author";
        markdownContent += `## ${book.title}\n`;
        markdownContent += `**Author(s)**: ${authorName}\n\n`;
        markdownContent += `**Description**: ${book.description}\n\n`;
        markdownContent += `[Read more](${book.url})\n\n`;
        markdownContent += "---\n\n";
    });

    const metadata = {
        name: "books.md", 
        mimeType: "text/markdown" 
    };
    
    const multipartRequestBody = 
        `--foo_bar_baz\nContent-Type: application/json; charset=UTF-8\n\n${JSON.stringify(metadata)}\n` +
        `--foo_bar_baz\nContent-Type: text/markdown\n\n${markdownContent}\n--foo_bar_baz--`;

    const options = {
        method: "POST",
        headers: {
            "Content-Type": "multipart/related; boundary=foo_bar_baz",
            Authorization: `Bearer ${access_token}`,
        },
    };

    const drive_request = https.request("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", options, (drive_stream) => {
        let data = "";
        drive_stream.on("data", (chunk) => (data += chunk));
        drive_stream.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(data);
        });
    });

    drive_request.on('error', (error) => {
        console.error('Error:', error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
    });

    drive_request.end(multipartRequestBody);
}