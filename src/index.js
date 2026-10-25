const { app } = require('./app');
const config = require('./config');

const PORT = config.port;

app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Urja Meter Ops API Service running on port ${PORT}`);
    console.log(`📖 Interactive Docs (Swagger UI): http://localhost:${PORT}/docs`);
    console.log(`📄 OpenAPI Spec: http://localhost:${PORT}/openapi.json`);
    console.log(`🩺 Health Check: http://localhost:${PORT}/health`);
    console.log(`⚡ Connected to portal: ${config.urja.baseUrl}`);
    console.log(`=======================================================`);
});
