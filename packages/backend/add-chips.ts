import { prisma } from './src/db/client';

async function addChips() {
  const users = await prisma.user.findMany();
  
  for (const user of users) {
    const balance = await prisma.chipBalance.findUnique({ 
      where: { userId: user.id } 
    });
    
    if (balance) {
      await prisma.chipBalance.update({
        where: { userId: user.id },
        data: { chips: { increment: BigInt(30_000_000) } }
      });
      console.log(`Added 30 chips to ${user.username}`);
    }
  }
  
  console.log('Done!');
}

addChips()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
