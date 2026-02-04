#!/usr/bin/env node

import fs from 'fs';
import { createHash } from 'crypto';

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

const CACHE_FILE = 'isbnmap.json';
const HARDCOVER_STATUS = {
    WANT_TO_READ: 1,
    READING: 2,
    READ: 3,
};
const TODAY = new Date().toISOString().split('T')[0];
const CONFIG = {
    HARDCOVER: {
        API_KEY: requireEnv('HARDCOVER_API_KEY'),
    },
    KOMGA: {
        HOST: requireEnv('KOMGA_HOST'),
        API_KEY: requireEnv('KOMGA_API_KEY'),
        BOOKS_LIBRARY_ID: requireEnv('KOMGA_BOOKS_LIBRARY_ID'),
    },
};

async function wait(seconds = 0.5) {
    await new Promise(resolve => {
        setTimeout(resolve, seconds * 1000);
    });
}

class Hardcover {
    async request(body) {
        const response = await fetch('https://api.hardcover.app/v1/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.HARDCOVER.API_KEY}`,
            },
            body: JSON.stringify(body),
        });
        const responseJson = await response.json();
        await wait();
        return responseJson;
    }

    async getBookId(isbn) {
        // Search for the book by ISBN
        let response = await this.request({
            query: `query SearchQuery {
                search(query_type: "book", query: "${isbn}") {
                    results
                }
            }`
        });
        const results = response.data.search.results;

        if (results.found === 0) {
            throw new Error(`Failed to find Hardcover book for ISBN ${isbn}`);
        }
        return results.hits[0].document.id;
    }

    async getUserBook(bookId) {
        const response = await this.request({
            query: `query GetUserBook {
                me {
                    user_books(where: {book: {id: {_eq: ${bookId}}}}) {
                        id
                        status_id
                        book_id
                        book {
                            slug
                            title
                        }
                        edition  {
                            id
                            pages
                        }
                        user_book_reads(order_by: {started_at: desc}) {
                            id
                            started_at
                            finished_at
                            edition_id
                            progress_pages
                        }
                    }
                }
            }`
        });

        // console.debug(`GetUserBook(${bookId})`, JSON.stringify(response, null, 2));
        const userBooks = response.data?.me ?? [];
        if (userBooks.length) {
            return userBooks[0].user_books.length ? userBooks[0].user_books[0] : null;
        }
        return null;
    }

    async addUserBook(bookId) {
        const response = await this.request({
            query: `mutation AddBook($object: UserBookCreateInput!) {
                insert_user_book(object: $object) {
                    error
                    user_book {
                        id
                        status_id
                        book_id
                        book {
                            slug
                            title
                        }
                        edition  {
                            id
                            pages
                        }
                        user_book_reads(order_by: {started_at: desc}) {
                            id
                            started_at
                            finished_at
                            edition_id
                            progress_pages
                        }
                    }
                }
            }`,
            variables: {
                object: {
                    book_id: bookId,
                    status_id: HARDCOVER_STATUS.WANT_TO_READ,
                },
            },
        });

        // console.debug(`addUserBook(${bookId})`, JSON.stringify(response, null, 2));
        return response.data?.insert_user_book?.user_book;
    }

    async changeBookStatus(bookId, status) {
        const response = await this.request({
            query: `mutation ChangeBookStatus($id: Int!, $status_id: Int!)  {
                update_user_book(id: $id, object: {status_id: $status_id}) {
                    error
                }
            }`,
            variables: {
                id: bookId,
                status_id: status,
            },
        });

        // console.debug(`changeBookStatus(${bookId})`, JSON.stringify(response, null, 2));
    }

    async addUserBookRead(userBook, pages) {
        const response = await this.request({
            query: `mutation AddUserBookRead($id: Int!, $pages: Int, $editionId: Int, $startedAt: date)  {
                insert_user_book_read(user_book_id: $id, user_book_read: {
                    progress_pages: $pages,
                    edition_id: $editionId,
                    started_at: $startedAt,
                }) {
                    error
                    user_book_read {
                        id
                        started_at
                        finished_at
                        edition_id
                        progress_pages
                    }
                }
            }`,
            variables: {
                id: userBook?.id,
                pages,
                editionId: userBook?.edition?.id,
                startedAt: TODAY,
            },
        });

        // console.debug(`addUserBookRead(${userBook.id})`, JSON.stringify(response, null, 2));
        return response.data?.insert_user_book_read?.user_book_read;
    }

    async deleteUserBookRead(userBookReadId) {
        const response = await this.request({
            query: `mutation DeleteUserBookRead($id: Int!)  {
                delete_user_book_read(id: $id) {
                    error
                }
            }`,
            variables: {
                id: userBookReadId,
            },
        });

        // console.debug(`addUserBookRead(${userBook.id})`, JSON.stringify(response, null, 2));
    }

    async updateProgress(userBook, userBookRead, progressPercentage) {
        const edtionPages = userBook?.edition?.pages ?? 0;
        const progressPages = Math.floor(edtionPages * progressPercentage);

        const response = await this.request({
            query: `mutation UpdateProgress($id: Int!, $editionId: Int, $progressPages: Int, $startedAt: date, $finishedAt: date) {
                update_user_book_read(
                    id: $id,
                    object: {
                        progress_pages: $progressPages,
                        edition_id: $editionId,
                        started_at: $startedAt,
                        finished_at: $finishedAt,
                    }
                ) {
                    id
                }
            }`,
            variables: {
                id: userBookRead.id,
                progressPages,
                editionId: userBookRead?.edition_id ?? userBook?.edition?.id,
                startedAt: userBookRead?.started_at ?? TODAY,
                finishedAt: progressPercentage == 1 ? TODAY : null,
            }
        });

        // console.debug(`updateProgress(${userBook.id}, ${userBookRead.id}, ${progressPages})`, JSON.stringify(response, null, 2));
    }
}

async function getKomgaBooks() {
    const books = [];
    let totalElements = Infinity;
    let page = 0;

    while (books.length < totalElements) {
        const url = `${CONFIG.KOMGA.HOST}/api/v1/books/list?page=${page}`;
        const headers = {
            'Content-Type': 'application/json',
            'X-API-Key': CONFIG.KOMGA.API_KEY,
        };
        const postData = {
            condition: {
                libraryId: {
                    operator: 'is',
                    value: CONFIG.KOMGA.BOOKS_LIBRARY_ID,
                }
            }
        };
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(postData)
        });

        const body = await response.json();
        if (body.content.length == 0) {
            break;
        }

        totalElements = body.totalElements;
        books.push(...body.content);
        page++;
    }

    return books;
}

function hashObject(obj) {
    const sortedObj = Object.keys(obj).sort().reduce((state, key) => {
        return Object.assign(state, { [key]: obj[key] })
    }, {});
    return createHash('md5').update(JSON.stringify(sortedObj)).digest('hex');
}

const hardcover = new Hardcover();
let isbnMap;
try {
    isbnMap = JSON.parse(fs.readFileSync(CACHE_FILE));
} catch (error) {
    isbnMap = {};
}

const komgaBooks = await getKomgaBooks();
fs.writeFileSync('books.json', JSON.stringify(komgaBooks, null, 2));
console.log(`Processing ${komgaBooks.length} books`);

for (const book of komgaBooks) {
    const {
        metadata: { isbn, title }, media: { pagesCount }
    } = book;
    const readProgress = book.readProgress ?? {};

    // get cached book, or find the hardcover ID
    let bookId = isbnMap[isbn] ? isbnMap[isbn].bookId : null;
    if (bookId == null) {
        try {
            bookId = await hardcover.getBookId(isbn);
            // dummy data for new book
            isbnMap[isbn] = {
                bookId,
                title,
                readProgress,
                readProgressHash: hashObject(readProgress),
            };
        } catch (error) {
            console.error(error);
            continue;
        }
    }
    bookId = parseInt(bookId);

    const logPrefix = `${bookId} - ${title.length > 30 ? title.slice(0, 29) + '…' : title}`;
    const cachedBook = isbnMap[isbn];
    const readProgressHash = hashObject(readProgress);

    // if there's new progress activity and the book wasn't already completed
    if (readProgressHash !== cachedBook.readProgressHash && !cachedBook.readProgress.completed) {
        console.info(`${logPrefix}: New activity`);

        const { completed, page } = readProgress;

        let userBook = await hardcover.getUserBook(bookId);
        if (userBook == null) {
            console.info(`${logPrefix}: Adding book`);
            userBook = await hardcover.addUserBook(bookId);
        }

        if (userBook.status_id !== HARDCOVER_STATUS.READ && completed) {
            console.info(`${logPrefix}: Setting status to READ`);
            await hardcover.changeBookStatus(userBook.id, HARDCOVER_STATUS.READ);
        } else if (userBook.status_id === HARDCOVER_STATUS.WANT_TO_READ) {
            console.info(`${logPrefix}: Setting status to READING`);
            await hardcover.changeBookStatus(userBook.id, HARDCOVER_STATUS.READING);
        }

        let userBookReads = userBook?.user_book_reads ?? [];
        // sometimes we end up with more than one read, no idea
        for (const userBookRead of userBookReads.slice(1)) {
            console.info(`${logPrefix}: Deleting user book read ${userBookRead.id}`)
            await hardcover.deleteUserBookRead(userBookRead.id);
        }

        const progressPercentage = completed ? 1 : (page / pagesCount).toFixed(2);
        if (progressPercentage < 0.05) {
            // less than 5%, haven't really started reading this book yet
            continue;
        }

        let userBookRead = userBookReads[0] ?? null;
        if (userBookRead == null) {
            console.info(`${logPrefix}: Adding user book read`);
            userBookRead = await hardcover.addUserBookRead(userBook, 0);
        }

        console.info(`${logPrefix}: Updating page progress to ${progressPercentage * 100}%`);
        await hardcover.updateProgress(userBook, userBookRead, progressPercentage);
    } else {
        console.info(`${logPrefix}: No change`);
    }

    // update the cache for this book
    isbnMap[isbn] = { bookId, title, readProgress, readProgressHash };
}

fs.writeFileSync(CACHE_FILE, JSON.stringify(isbnMap, null, 2));
