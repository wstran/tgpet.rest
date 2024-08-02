import fs from 'fs';
import path from 'path';
import express from "express";

const router = express.Router();

const folders = fs.readdirSync('./src/apis');

for (const folder of folders) {
    if (!folder.includes('.')) {
        const apis = fs.readdirSync('./src/apis/' + folder);
        for (const api of apis) {
            if (api.includes('.')) {
                const workerPath = path.join('./src/apis/', folder + '/' + api);

                import('../../' + workerPath).then((value) => {
                    if (typeof value.default === 'function') {
                        value.default(router);
                    };
                });
            };
        };
    };
};

export default router;
