const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken')
// const nodemailer = require("nodemailer");
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
// console.log(stripe);

const port = process.env.PORT || 5000;

const app = express();

// middle ware
app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ok9cief.mongodb.net/?retryWrites=true&w=majority`;
// console.log(uri);
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

// function sandBookingEmail(booking) {
//     const { appointmentDate, email, treatment,  slot } = booking;
//     let transporter = nodemailer.createTransport({
//         host: 'smtp.sendgrid.net',
//         port: 587,
//         auth: {
//             user: "apikey",
//             pass: process.env.SENDGRID_API_KEY
//         }
//     });

//     transporter.sendMail({
//         from: "mdsabbir477470@gmail.com", // verified sender email
//         to: email, // recipient email
//         subject: `Your appointment for ${treatment} is confirmed`, // Subject line
//         text: "Hello world!", // plain text body
//         html: `
//         <h3>Your appointment is confirmed</h3>
//         <div>
//             <p>Your appointment for treatment: ${treatment}</p>
//             <p>Please visit us on ${appointmentDate} at ${slot}</p>
//             <p>Thanks from Doctor Portal</p>

//         </div>
//         `, // html body
//       }, function(error, info){
//         if (error) {
//           console.log(error);
//         } else {
//           console.log('Email sent: ' + info.response);
//         }
//       });
// }

function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send('unauthorized access');
    }

    const token = authHeader.split(' ')[1];

    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded;
        next();
    })

}




async function run() {
    try {
        const appointmentOptionCollection = client.db('doctorPortal').collection('appointmentOptions');
        const bookingsCollection = client.db('doctorPortal').collection('bookings');
        const usersCollection = client.db('doctorPortal').collection('users');
        const doctorsCollection = client.db('doctorPortal').collection('doctors');
        const paymentsCollection = client.db('doctorPortal').collection('payments');
        // const submitCollection = client.db('doctorPortal').collection('submit');
        


        // NOTE: make sure you use verifyAdmin after verifyJWT
        const verifyAdmin = async (req, res, next) =>{
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }

        // Use Aggregate to query multiple collection and then merge data
        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const query = {};
            const options = await appointmentOptionCollection.find(query).toArray();

            // get the bookings of the provided date
            const bookingQuery = { appointmentDate: date }
            const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();

            // code carefully :D
            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
                const bookedSlots = optionBooked.map(book => book.slot);
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot));
                option.slots = remainingSlots;
            })

            res.send(options);
        });

        // 
        app.get('/appointmentSpecialty', async (req, res) => {
            const query = {}
            const result = await appointmentOptionCollection.find(query).project({ name: 1 }).toArray();
            res.send(result);
        })

        // mongodb operator pipeline....
        app.get('/v2/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const options = await appointmentOptionCollection.aggregate([
                {
                    $lookup: {
                        from: 'bookings',
                        localField: 'name',
                        foreignField: 'treatment',
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ['$appointmentDate', date]
                                    }
                                }
                            }
                        ],
                        as: 'booked'
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: 1,
                        booked: {
                            $map: {
                                input: '$booked',
                                as: 'book',
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: {
                            $setDifference: ['$slots', '$booked']
                        }
                    }
                }
            ]).toArray();
            res.send(options);
        });


        // booking ta query korsi
        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const bookings = await bookingsCollection.find(query).toArray();
            res.send(bookings);
        })

        // user thka bookings nita si
        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            console.log(booking);
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }

            const alreadyBooked = await bookingsCollection.find(query).toArray();

            if (alreadyBooked.length) {
                const message = `You already have a booking on ${booking.appointmentDate}`
                return res.send({ acknowledged: false, message })
            }

            const result = await bookingsCollection.insertOne(booking);
            // sand email about appointment confirmation
            // sandBookingEmail(booking);
            res.send(result);
        });

        // specaifik 1 id ka dorer jonno...
        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const booking = await bookingsCollection.findOne(query);
            res.send(booking);
        })

        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1d' })
                return res.send({ accessToken: token });
            }
            res.status(403).send({ accessToken: '' })
        });

        // create
        app.post('/users', async (req, res) => {
            const user = req.body;
            console.log('user',user);
            const result = await usersCollection.insertOne(user);
            res.send(result);
        })

        app.get('/users', async (req, res) => {
            const query = {};
            const users = await usersCollection.find(query).toArray();
            res.send(users);
        });

        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email }
            const user = await usersCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' });
        })


        app.put('/users/admin/:id', verifyJWT, async (req, res) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }

            const id = req.params.id;
            const filter = { _id: ObjectId(id) }
            const options = { upsert: true };
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await usersCollection.updateOne(filter, updatedDoc, options);
            res.send(result);
        });

        // temporary to update price field on appointment options
        // app.get('/addPrice', async (req, res) => {
        //     const filter = {}
        //     const options = { upsert: true }
        //     const updatedDoc = {
        //         $set: {
        //             price: 99
        //         }
        //     }
        //     const result = await appointmentOptionCollection.updateMany(filter, updatedDoc, options);
        //     res.send(result);
        // })

        // app.delete('/users/:id', verifyJWT, async (req, res) => {
        //     const id = req.params.id;
        //     const filter = { _id: ObjectId(id) };
        //     const result = await usersCollection.deleteOne(filter);
        //     res.send(result);
        // })

        // ............ doctorsCollection...............
        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const doctors = await doctorsCollection.find(query).toArray();
            res.send(doctors);
        })

        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        });

        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result);
        })


        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            console.log(booking);
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                currency: 'usd',
                amount: amount,
                "payment_method_types": [
                    "card"
                ]
            });
            console.log('paymentIntent.client_secret',paymentIntent.client_secret);
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });

        app.post('/payments', async (req, res) =>{
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId
            const filter = {_id: ObjectId(id)}
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const updatedResult = await bookingsCollection.updateOne(filter, updatedDoc)
            res.send(result);
        })

        // // doctor Portalo website all submit collection..
        // app.post('/submit', async (req, res) => {
        //     const body = req.body;
        //     const doc = body;
        //     console.log(doc);
        //     const result = await submitCollection.insertOne(doc)
        //     console.log(result);
        //     res.send(result)
        // });

        /***

         * .......API Naming Convention for bookings ......
         * app.get('/bookings')
         * app.get('/bookings/:id')
         * app.post('/bookings')
         * app.patch('/bookings/:id)
         * app.delete('/bookings/:id')
        
         ***/
    
    }
    finally {
        
    }
  }
  run().catch(console.dir);


app.get('/', async (req, res) => {
    res.send('doctors portal server is running');
});

app.listen(port, () => console.log(`doctors portal server running on ${port}`));