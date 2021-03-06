const Mongod = require("mongod");
const path = require("path");
const _ = require("lodash");
const { expect } = require("chai");
const Pocket = require("../src/pocket");
const { isCI } = require("../src/utils/helpers");
const Schema = require("../src/schema/index");

let mongoServer = null;
const setupsToTest = {
  DISK: {
    config: null,
    bootstrap: done => done(),
    close: done => done()
  },
  MONGO: {
    config: {
      datastore: {
        adapter: "mongo",
        options: {
          url: "localhost:27017",
          dbName: "mocha_test_db"
        }
      }
    },
    bootstrap: done => {
      if (isCI()) {
        return done();
      }

      console.log("Starting mongod");
      mongoServer = new Mongod(27017);
      mongoServer.open(done);
    },
    close: done => {
      if (isCI()) {
        return done();
      }
      console.log("Stopping mongod");
      mongoServer.close(done);
    }
  }
};

_.each(setupsToTest, ({ config, bootstrap, close }, key) => {
  describe(`[${key}] Resource`, () => {
    let pocket = null;
    let schema = null;
    let resource = null;

    before(done => {
      bootstrap(err => {
        if (err) {
          return done(err);
        }
        schema = new Schema({
          additionalProperties: false,
          fields: {
            firstname: "string",
            lastname: "string",
            age: { type: "number" },
            username: {
              type: "string",
              index: {
                unique: true
              }
            },
            nickname: {
              type: 'string',
              computed: true,
              compute(record) {
                if (!record.firstname) {
                  return 'unnamed';
                }
                return 'little ' + record.firstname.toLowerCase();
              }
            }
          }
        });
        pocket = new Pocket(config);
        resource = pocket.resource("person", schema);
        resource.drop().then(done);
      });
    });

    after(done => {
      pocket.jsonStore.close().then(() => {
        close(done);
      });
    });

    afterEach(done => {
      resource.drop().then(() => done());
    });

    it("Should save a record to the database", async () => {
      const data = await resource.create({ firstname: "John" });
      data.should.not.be.undefined;
      data._id.should.not.be.undefined;
      data._id.should.be.a('string');
    });

    it("Should fail to create a record with invalid schema", done => {
      resource
        .create({ firstname: "John", bad: "property" })
        .should.be.rejected.notify(done);
    });

    it("Should fail to create a record if a unique property is already used", done => {
      resource
        .create({ firstname: "Cedric", username: "KebabLover69" })
        .then(() => {
          return resource.create({
            firstname: "Marcel",
            username: "KebabLover69"
          });
        })
        .should.be.rejected.notify(done);
    });

    it("Should fetch a record by it's id", done => {
      resource
        .create({ firstname: "John" })
        .then(record => resource.get(record._id))
        .then(record => {
          record.should.exist;
        })
        .should.be.fulfilled.notify(done);
    });

    it("Should find a record by it's properties", done => {
      resource
        .create({ firstname: "John" })
        .then(record => resource.find({ firstname: "John" }))
        .then(records => {
          records.should.exist;
          expect(records).to.have.lengthOf(1);
        })
        .should.be.fulfilled.notify(done);
    });

    it("Should update/merge a single record", done => {
      resource
        .create({ firstname: "John", lastname: "Smith" })
        .then(record => resource.get(record._id))
        .then(record => {
          expect(record).not.to.be.null;
          expect(record).not.to.be.undefined;
          record.lastname = "Doe";
          return resource.mergeOne(record._id, record);
        })
        .then(r => {
          expect(r).not.to.be.null;
          expect(r.lastname).to.equal("Doe");
        })
        .should.be.fulfilled.notify(done);
    });

    it("Should upsert a single record", async () => {
      const record = await resource.upsertOne({
        firstname: "Fred"
      }, {
        firstname: "Fred",
        lastname: "Page"
      });

      expect(record).to.haveOwnProperty('_id');

      const updatedRecord = await resource.upsertOne({
        firstname: "Fred"
      }, {
        firstname: "Jimmy"
      });

      expect(updatedRecord._id).to.equal(record._id);
      expect(updatedRecord.firstname).to.equal("Jimmy");
    });

    it("Should attach a file to a record", async () => {
      const record = await resource.create({
        firstname: "John",
        lastname: "Smith"
      });
      const file = path.join(__dirname, "samples", "sample_image.png");
      const updatedRecord = await resource.attach(record._id, "myimage", file);

      expect(updatedRecord).to.be.an("object");
      expect(updatedRecord.lastname).to.equal("Smith");
      expect(updatedRecord._attachments).to.be.an("array");
      expect(updatedRecord._attachments).to.be.of.length(1);

      const att = updatedRecord._attachments[0];
      expect(att).not.to.be.undefined;
      expect(att.name).to.equal("myimage");
      expect(att.file).to.be.a("string");
      expect(att.id).to.be.a("string");
    });

    it("Should fail to attach a bad file to a record", done => {
      resource
        .create({ firstname: "John", lastname: "Smith" })
        .then(record => resource.get(record._id))
        .then(record => {
          let file = path.join(__dirname, "samples", "./i.dont.exist");
          return resource.attach(record._id, "myimage", file);
        })
        .should.be.rejected.notify(done);
    });

    it("Should read an attachment from it's id", done => {
      resource
        .create({ firstname: "John", lastname: "Smith" })
        .then(record => resource.get(record._id))
        .then(record => {
          let file = path.join(__dirname, "samples", "sample_image.png");
          return resource.attach(record._id, "myimage", file);
        })
        .then(record => {
          const att = record._attachments[0];
          const stream = resource.readAttachment(att.id);

          expect(stream).to.be.an("object");
          expect(stream.pipe).to.be.a("function");
        })
        .should.be.fulfilled.notify(done);
    });

    it("Should delete an attachment from it's id", done => {
      resource
        .create({ firstname: "John", lastname: "Smith" })
        .then(record => resource.get(record._id))
        .then(record => {
          let file = path.join(__dirname, "samples", "sample_image.png");
          return resource.attach(record._id, "myimage", file);
        })
        .then(record => {
          const att = record._attachments[0];
          const stream = resource.readAttachment(att.id);

          return resource.deleteAttachment(record._id, att.id);
        })
        .then(record => {
          expect(record._attachments).to.be.of.length(0);
        })
        .should.be.fulfilled.notify(done);
    });

    it("Should delete a record by it's id", done => {
      let id;
      resource
        .create({ firstname: "John" })
        .then(record => {
          id = record._id;
          resource.removeOne(record._id);
        })
        .then(() => resource.get(id))
        .should.eventually.be.null.notify(done);
    });

    it("Should support pagination", async () => {
      await resource.drop();
      for (let i = 0; i < 10; ++i) {
        await resource.create({ username: "random " + i });
      }

      let page1 = await resource.find({}, { pageSize: 6, page: 1 });
      expect(page1).to.be.an("array");
      expect(page1.length).to.equal(6);
      expect(page1.meta).to.be.an("object");
      expect(page1.meta.page).to.equal(1);
      expect(page1.meta.pageSize).to.equal(6);
      expect(page1.meta.totalPages).to.equal(2);

      let page2 = await resource.find({}, { pageSize: 6, page: 2 });
      expect(page2).to.be.an("array");
      expect(page2.length).to.equal(4);
      expect(page2.meta.page).to.equal(2);
      expect(page2.meta.pageSize).to.equal(6);
      expect(page2.meta.totalPages).to.equal(2);
    });

    it("Should support computed properties", async () => {
      const data = await resource.create({ firstname: "John" });
      expect(data.nickname).to.equal('little john');

      const fetchedData = await resource.findOne({ _id: data._id });
      expect(fetchedData.nickname).to.equal('little john');

      const rawData = await resource.findOne({ _id: data._id }, { skipComputation: true });
      expect(rawData).not.to.have.property('nickname');
    });

    it("Should allow streaming records", async () => {
      for (let i = 0; i < 10; ++i) {
        await resource.create({ username: "John " + i });
      }

      let count = 0;
      await resource.each({}, async (record) => {
        expect(record.username).to.match(/John \d/);
        count++;
      });

      expect(count).to.equal(10);
    });

    describe("Hooks", () => {
      afterEach(done => {
        schema.clearHooks();
        done();
      });

      it("Should allow before and after find hook", async () => {
        let beforeTriggered = false;
        let afterTrigerred = false;

        let user = await resource.create({
          username: "john",
          firstname: "john"
        });

        schema.before("find", async ({ query }, ctx) => {
          expect(ctx).to.exist;
          expect(query).not.to.be.null;
          expect(query._id).to.equal("badId");

          query._id = user._id; // override
          beforeTriggered = true;
        });

        schema.after("find", async ({ records }, ctx) => {
          let record = records[0];
          expect(ctx).to.exist;
          expect(record).not.to.be.null;
          expect(record._id.toString()).to.equal(user._id.toString());
          expect(record.username).to.equal("john");

          record.username = record.username + "ny";
          afterTrigerred = true;
        });

        let foundUser = await resource.findOne({ _id: "badId" });
        expect(beforeTriggered).to.be.true;
        expect(afterTrigerred).to.be.true;
        expect(foundUser.username).to.equal("johnny");
      });

      it("Should allow before and after validate hook", async () => {
        let beforeTriggered = false;
        let afterTrigerred = false;

        schema.before("validate", async ({ record, schema }, ctx) => {
          expect(ctx).to.exist;
          expect(record).to.exist;
          expect(schema).to.exist;
          expect(record.username).to.equal("john");
          record.username += " was";
          beforeTriggered = true;
        });

        schema.after("validate", async ({ record, schema, errors }, ctx) => {
          expect(ctx).to.exist;
          expect(record).to.exist;
          expect(schema).to.exist;
          expect(errors).to.exist;
          expect(errors).to.be.an("array");
          expect(record.username).to.equal("john was");

          record.username += " validated";
          afterTrigerred = true;
        });

        let user = await resource.create({
          username: "john",
          firstname: "john"
        });
        expect(beforeTriggered).to.be.true;
        expect(afterTrigerred).to.be.true;
        expect(user.username).to.equal("john was validated");
      });

      it("Should allow before and after update hook", async () => {
        let beforeTriggered = false;
        let afterTrigerred = false;

        let user = await resource.create({
          username: "Hulk",
          firstname: "patrick"
        });

        schema.before("update", async ({ query, operations }, ctx) => {
          expect(ctx).to.exist;
          expect(query).to.exist;
          expect(operations).to.exist;
          expect(query._id).to.equal(user._id);
          beforeTriggered = true;
        });

        schema.after("update", async ({ query, operations }, ctx) => {
          expect(ctx).to.exist;
          expect(query).to.exist;
          expect(operations).to.exist;
          afterTrigerred = true;
        });

        user = await resource.mergeOne(user._id, { firstname: "vlad" });
        expect(beforeTriggered).to.be.true;
        expect(afterTrigerred).to.be.true;
      });

      it("Should allow before and after remove hook", async () => {
        let beforeTriggered = false;
        let afterTrigerred = false;

        let user = await resource.create({
          username: "Hulk",
          firstname: "patrick"
        });

        schema.before("remove", async ({ query, options }, ctx) => {
          expect(ctx).to.exist;
          expect(query).to.exist;
          expect(options).to.exist;
          expect(query._id).to.equal(user._id);
          beforeTriggered = true;
        });

        schema.after(
          "remove",
          async ({ query, options, removedCount }, ctx) => {
            expect(ctx).to.exist;
            expect(query).to.exist;
            expect(options).to.exist;
            expect(removedCount).to.equal(1);
            afterTrigerred = true;
          }
        );

        await resource.removeOne(user._id);
        expect(beforeTriggered).to.be.true;
        expect(afterTrigerred).to.be.true;
      });

      it("Should allow before create and save hooks", async () => {
        let wasCreated = false;
        let wasSaved = false;

        schema.before("create", async ({ record }, ctx) => {
          expect(ctx).to.exist;
          expect(record).not.to.be.null;
          expect(record.firstname).to.equal("john");
          expect(record.username).to.equal("test");
          wasCreated = true;
          record.username = record.username + "!";
        });

        schema.before("save", async ({ record }, ctx) => {
          expect(ctx).to.exist;
          expect(record).not.to.be.null;
          expect(record.firstname).to.equal("john");
          expect(record.username).to.equal("test!");
          wasSaved = true;
          record.username = record.username + "@";
        });

        let user = await resource.create({
          username: "test",
          firstname: "john"
        });
        expect(wasCreated).to.be.true;
        expect(wasSaved).to.be.true;
        expect(user.username).to.equal("test!@");
      });

      it("Should allow after create and save hooks", async () => {
        let wasCreated = false;
        let wasSaved = false;
        schema.after("create", async ({ record }, ctx) => {
          expect(ctx).to.exist;
          expect(record).not.to.be.null;
          expect(record._id).not.to.be.null;
          expect(record.firstname).to.equal("john");
          expect(record.username).to.equal("test");

          record.username = record.username + "!";

          const inStoreRecord = resource.get(record._id);
          expect(inStoreRecord).not.to.be.null;
          wasCreated = true;
        });

        schema.after("save", async ({ record }, ctx) => {
          expect(ctx).to.exist;
          expect(record).not.to.be.null;
          expect(record._id).not.to.be.null;
          expect(record.firstname).to.equal("john");
          expect(record.username).to.equal("test!");

          record.username = record.username + "@";

          const inStoreRecord = resource.get(record._id);
          expect(inStoreRecord).not.to.be.null;
          wasSaved = true;
        });

        let user = await resource.create({
          username: "test",
          firstname: "john"
        });
        expect(wasCreated).to.be.true;
        expect(wasSaved).to.be.true;
        expect(user.username).to.equal("test!@");
      });
    });
  });
});
