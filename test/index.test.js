'use strict';

const assert = require('chai').assert;
const sinon = require('sinon');
const mockery = require('mockery');

sinon.assert.expose(assert, { prefix: '' });

const TEST_TIM_YAML = `
metadata:
  name: {{build_id_with_prefix}}
  container: {{container}}
  launchVersion: {{launcher_version}}
command:
- "/opt/sd/launch {{api_uri}} {{store_uri}} {{token}} {{build_id}}"
`;

describe('index', function () {
    // Time not important. Only life important.
    this.timeout(5000);

    let Executor;
    let requestMock;
    let fsMock;
    let executor;
    const testBuildId = 15;
    const testToken = 'abcdefg';
    const testApiUri = 'http://api:8080';
    const testStoreUri = 'http://store:8080';
    const testContainer = 'node:4';
    const testLaunchVersion = 'stable';
    const podsUrl = 'https://kubernetes.default/api/v1/namespaces/default/pods';

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        requestMock = sinon.stub();

        fsMock = {
            readFileSync: sinon.stub(),
            existsSync: sinon.stub()
        };

        fsMock.readFileSync.withArgs('/var/run/secrets/kubernetes.io/serviceaccount/token')
            .returns('api_key');
        fsMock.readFileSync.withArgs(sinon.match(/config\/pod.yaml.tim/))
            .returns(TEST_TIM_YAML);
        fsMock.existsSync.returns(true);

        mockery.registerMock('fs', fsMock);
        mockery.registerMock('request', requestMock);

        /* eslint-disable global-require */
        Executor = require('../index');
        /* eslint-enable global-require */

        executor = new Executor({
            ecosystem: {
                api: testApiUri,
                store: testStoreUri
            },
            fusebox: { retry: { minTimeout: 1 } },
            prefix: 'beta_'
        });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    it('supports specifying a specific version', () => {
        assert.equal(executor.launchVersion, 'stable');
        assert.equal(executor.token, 'api_key');
        assert.equal(executor.host, 'kubernetes.default');
        executor = new Executor({
            kubernetes: {
                token: 'api_key2',
                host: 'kubernetes2',
                jobsNamespace: 'baz',
                baseImage: 'hyperctl'
            },
            prefix: 'beta_',
            launchVersion: 'v1.2.3'
        });
        assert.equal(executor.prefix, 'beta_');
        assert.equal(executor.token, 'api_key2');
        assert.equal(executor.host, 'kubernetes2');
        assert.equal(executor.launchVersion, 'v1.2.3');
        assert.equal(executor.jobsNamespace, 'baz');
        assert.equal(executor.baseImage, 'hyperctl');
    });

    it('allow empty options', () => {
        fsMock.existsSync.returns(false);
        executor = new Executor();
        assert.equal(executor.launchVersion, 'stable');
        assert.equal(executor.host, 'kubernetes.default');
        assert.equal(executor.launchVersion, 'stable');
        assert.equal(executor.prefix, '');
        assert.equal(executor.token, '');
    });

    it('extends base class', () => {
        assert.isFunction(executor.stop);
        assert.isFunction(executor.start);
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            assert.deepEqual(executor.stats(), {
                requests: {
                    total: 0,
                    timeouts: 0,
                    success: 0,
                    failure: 0,
                    concurrent: 0,
                    averageTime: 0
                },
                breaker: {
                    isClosed: true
                }
            });
        });
    });

    describe('stop', () => {
        const fakeStopResponse = {
            statusCode: 200,
            body: {
                success: 'true'
            }
        };
        const deleteConfig = {
            uri: podsUrl,
            method: 'DELETE',
            qs: {
                labelSelector: `sdbuild=beta_${testBuildId}`
            },
            headers: {
                Authorization: 'Bearer api_key'
            },
            strictSSL: false
        };

        beforeEach(() => {
            requestMock.yieldsAsync(null, fakeStopResponse, fakeStopResponse.body);
        });

        it('calls breaker with correct config', () => (
            executor.stop({
                buildId: testBuildId
            }).then(() => {
                assert.calledWith(requestMock, deleteConfig);
                assert.calledOnce(requestMock);
            })
        ));

        it('returns error when breaker does', () => {
            const error = new Error('error');

            requestMock.yieldsAsync(error);

            return executor.stop({
                buildId: testBuildId
            }).then(() => {
                throw new Error('did not fail');
            }, (err) => {
                assert.deepEqual(err, error);
                assert.equal(requestMock.callCount, 5);
            });
        });

        it('returns error when response is non 200', () => {
            const fakeStopErrorResponse = {
                statusCode: 500,
                body: {
                    error: 'foo'
                }
            };

            const returnMessage = 'Failed to delete pod: '
                  + `${JSON.stringify(fakeStopErrorResponse.body)}`;

            requestMock.yieldsAsync(null, fakeStopErrorResponse, fakeStopErrorResponse.body);

            return executor.stop({
                buildId: testBuildId
            }).then(() => {
                throw new Error('did not fail');
            }, (err) => {
                assert.equal(err.message, returnMessage);
            });
        });
    });

    describe('start', () => {
        const fakeStartResponse = {
            statusCode: 201,
            body: {
                success: true
            }
        };

        beforeEach(() => {
            requestMock.yieldsAsync(null, fakeStartResponse, fakeStartResponse.body);
        });

        it('successfully calls start', () => {
            const postConfig = {
                uri: podsUrl,
                method: 'POST',
                json: {
                    metadata: {
                        name: 'beta_15',
                        container: testContainer,
                        launchVersion: testLaunchVersion
                    },
                    command: [
                        '/opt/sd/launch http://api:8080 http://store:8080 abcdefg '
                        + '15'
                    ]
                },
                headers: {
                    Authorization: 'Bearer api_key'
                },
                strictSSL: false
            };

            return executor.start({
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            }).then(() => {
                assert.calledOnce(requestMock);
                assert.calledWith(requestMock, postConfig);
            });
        });

        it('returns error when request responds with error', () => {
            const error = new Error('lol');

            requestMock.yieldsAsync(error);

            return executor.start({
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            }).then(() => {
                throw new Error('did not fail');
            }, (err) => {
                assert.deepEqual(err, error);
            });
        });

        it('returns body when request responds with error in response', () => {
            const returnResponse = {
                statusCode: 500,
                body: {
                    statusCode: 500,
                    message: 'lol'
                }
            };
            const returnMessage = `Failed to create pod: ${JSON.stringify(returnResponse.body)}`;

            requestMock.yieldsAsync(null, returnResponse, returnResponse.body);

            return executor.start({
                buildId: testBuildId,
                container: testContainer,
                token: testToken,
                apiUri: testApiUri
            }).then(() => {
                throw new Error('did not fail');
            }, (err) => {
                assert.equal(err.message, returnMessage);
            });
        });
    });
});